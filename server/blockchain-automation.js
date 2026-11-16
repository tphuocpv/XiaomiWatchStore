import { Contract, FetchRequest, JsonRpcProvider, Wallet } from "ethers";
import { assertLocalChainRpc, chainId, rpcUrl } from "../local-network.js";
import { loadCryptoDeployment, verifyEscrowTransaction } from "./crypto-payments.js";
import { pool } from "./db.js";

export const orderStatusCode = { pending: 1, confirmed: 2, packing: 3, shipped: 4, delivered: 5, cancelled: 6 };
const deploymentFile = new URL("../public/deployment.json", import.meta.url);
const escrowEvents = {
  markShipped: "OrderMarkedShipped",
  releaseOrder: "OrderReleased",
  refundOrder: "OrderRefunded",
  cancelUnpaidOrder: "OrderCancelled",
};
const unavailable = "Chưa thể ghi blockchain tự động. Hãy kiểm tra Hardhat và triển khai hợp đồng local.";
let lastEpoch;
let buyerSyncBlock;
let automationStatus = { ready: false, message: unavailable };
let signerQueue = Promise.resolve();
let processing = false;

export function getBlockchainAutomationStatus() {
  return automationStatus;
}

export async function enqueueOrderProof(connection, orderId, status) {
  await connection.execute(
    "INSERT IGNORE INTO blockchain_order_jobs (order_id, order_status) VALUES (?, ?)",
    [orderId, orderStatusCode[status]],
  );
}

export async function persistEscrowPayment(orderId, payment) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[order]] = await connection.execute(
      `SELECT o.payment_status AS paymentStatus, o.order_status AS orderStatus,
        cp.status AS cryptoStatus, cp.payment_tx_hash AS paymentTxHash
       FROM orders o JOIN crypto_payments cp ON cp.order_id = o.id WHERE o.id = ? FOR UPDATE`, [orderId],
    );
    if (order?.paymentTxHash?.toLowerCase() === payment.txHash.toLowerCase()) {
      await connection.commit();
      return { alreadyConfirmed: true };
    }
    if (order?.paymentStatus !== "unpaid" || order.cryptoStatus !== "unpaid"
        || !["pending", "confirmed", "packing"].includes(order.orderStatus)) {
      throw Object.assign(new Error("Đơn hàng đã thay đổi trạng thái trước khi xác nhận thanh toán."), { status: 409 });
    }
    await connection.execute(
      "UPDATE orders SET payment_status = 'paid', order_status = CASE WHEN order_status = 'pending' THEN 'confirmed' ELSE order_status END WHERE id = ?", [orderId],
    );
    await connection.execute(
      "UPDATE crypto_payments SET status = 'escrowed', buyer_address = ?, payment_tx_hash = ? WHERE order_id = ?",
      [payment.buyerAddress, payment.txHash, orderId],
    );
    if (order.orderStatus === "pending") await enqueueOrderProof(connection, orderId, "confirmed");
    await connection.commit();
    return { alreadyConfirmed: false };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function withLocalSigner(task) {
  assertLocalChainRpc();
  const key = process.env.CRYPTO_AUTOMATION_PRIVATE_KEY?.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? "")) throw new Error(unavailable);
  const rpc = new FetchRequest(rpcUrl);
  rpc.timeout = 3000;
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true, cacheTimeout: -1 });
  try {
    const deployment = await loadCryptoDeployment(deploymentFile);
    const wallet = new Wallet(key, provider);
    if (wallet.address !== deployment.admin || !deployment.instanceId || !deployment.registryBlockHash) {
      throw new Error(unavailable);
    }
    const metadata = await provider.send("hardhat_metadata", []);
    if (Number(metadata.chainId) !== chainId || metadata.instanceId !== deployment.instanceId) {
      throw new Error(unavailable);
    }
    return await task({ provider, deployment, wallet });
  } finally {
    provider.destroy();
  }
}

function serializeSigner(task) {
  const work = signerQueue.then(task);
  signerQueue = work.catch(() => {});
  return work;
}

async function sendTransaction(provider, wallet, contract, method, args) {
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const transaction = await contract[method](...args, { nonce });
  const receipt = await transaction.wait(1, 6000);
  if (receipt?.status !== 1) throw new Error("Giao dịch blockchain chưa được xác nhận.");
  return receipt.hash;
}

export function recordEscrowAction(order, method) {
  return serializeSigner(() => withLocalSigner(async ({ provider, deployment, wallet }) => {
    const escrow = new Contract(deployment.escrow.address, deployment.escrow.abi, wallet);
    const event = escrow.filters[escrowEvents[method]](order.blockchainKey);
    const previous = await escrow.queryFilter(event, deployment.escrow.blockNumber ?? 0);
    let txHash = previous.at(-1)?.transactionHash;
    if (!txHash) {
      if (method !== "cancelUnpaidOrder") {
        if (!order.paymentTxHash || !(await provider.getTransactionReceipt(order.paymentTxHash))) {
          throw new Error("Không tìm thấy khoản thanh toán ETH của đơn trên mạng hiện tại.");
        }
        await verifyEscrowTransaction({ provider, deployment, txHash: order.paymentTxHash, order,
          methodName: "payOrder", amountWei: order.amountWei });
      }
      txHash = await sendTransaction(provider, wallet, escrow, method, [order.blockchainKey]);
    }
    await verifyEscrowTransaction({ provider, deployment, txHash, order, methodName: method, amountWei: order.amountWei });
    return txHash;
  }));
}

export function canDeclineEscrowCancellation(order) {
  return serializeSigner(() => withLocalSigner(async ({ deployment, wallet }) => {
    const escrow = new Contract(deployment.escrow.address, deployment.escrow.abi, wallet);
    const { status } = await escrow.payments(order.blockchainKey);
    return ![4n, 5n].includes(status);
  }));
}

async function prepareProofJobs(deployment) {
  if (lastEpoch === deployment.registryBlockHash) return;
  const statuses = Object.keys(orderStatusCode);
  await pool.execute(
    `INSERT IGNORE INTO blockchain_order_jobs (order_id, order_status)
     SELECT id, FIELD(order_status, ?, ?, ?, ?, ?, ?) FROM orders
     WHERE blockchain_key IS NOT NULL AND blockchain_digest IS NOT NULL`, statuses,
  );
  await pool.execute(
    `UPDATE blockchain_order_jobs SET tx_hash = NULL, attempts = 0, retry_at = CURRENT_TIMESTAMP,
      registry_epoch = NULL WHERE tx_hash IS NOT NULL AND NOT (registry_epoch <=> ?)`, [deployment.registryBlockHash],
  );
  buyerSyncBlock = deployment.escrow.blockNumber ?? 0;
  lastEpoch = deployment.registryBlockHash;
}

async function syncBuyerPayments(provider, deployment) {
  const latestBlock = await provider.getBlockNumber();
  if (buyerSyncBlock > latestBlock) return;
  const lastBlock = Math.min(buyerSyncBlock + 499, latestBlock);
  const escrow = new Contract(deployment.escrow.address, deployment.escrow.abi, provider);
  const payments = await escrow.queryFilter(escrow.filters.PaymentEscrowed(), buyerSyncBlock, lastBlock);
  for (const event of payments) {
    if (!event.args) continue;
    const [[order]] = await pool.execute(
      `SELECT o.id, o.blockchain_key AS blockchainKey, o.blockchain_digest AS blockchainDigest, cp.amount_wei AS amountWei
       FROM orders o JOIN crypto_payments cp ON cp.order_id = o.id
       WHERE o.blockchain_key = ? AND o.payment_status = 'unpaid' AND cp.status = 'unpaid'
         AND o.order_status IN ('pending', 'confirmed', 'packing') LIMIT 1`,
      [event.args.orderKey],
    );
    if (!order) continue;
    const payment = await verifyEscrowTransaction({
      provider, deployment, txHash: event.transactionHash, order, methodName: "payOrder", amountWei: order.amountWei,
    });
    try { await persistEscrowPayment(order.id, payment); }
    catch (error) { if (error.status !== 409) throw error; }
  }
  buyerSyncBlock = lastBlock + 1;
}

async function saveProof(job, txHash, epoch) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      "UPDATE orders SET blockchain_tx_hash = ?, blockchain_status = ? WHERE id = ? AND order_status = ?",
      [txHash, job.status, job.orderId, Object.keys(orderStatusCode)[job.status - 1]],
    );
    await connection.execute(
      "UPDATE blockchain_order_jobs SET tx_hash = ?, registry_epoch = ?, attempts = 0 WHERE id = ?",
      [txHash, epoch, job.id],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

async function processProofJobs() {
  if (processing) return;
  processing = true;
  try {
    await withLocalSigner(async ({ provider, deployment }) => {
      const [registryCode, escrowCode] = await Promise.all([
        provider.getCode(deployment.address), provider.getCode(deployment.escrow.address),
      ]);
      if (registryCode === "0x" || escrowCode === "0x") throw new Error(unavailable);
      await prepareProofJobs(deployment);
      try { await syncBuyerPayments(provider, deployment); }
      catch { console.warn("Chưa đối chiếu được giao dịch ETH của khách. Máy chủ sẽ thử lại."); }
    });
    automationStatus = { ready: true };
    const [jobs] = await pool.execute(
      `SELECT j.id, j.order_id AS orderId, j.order_status AS status, j.attempts,
        o.blockchain_key AS orderKey, o.blockchain_digest AS digest
       FROM blockchain_order_jobs j JOIN orders o ON o.id = j.order_id
       WHERE j.tx_hash IS NULL AND j.retry_at <= CURRENT_TIMESTAMP
         AND NOT EXISTS (SELECT 1 FROM blockchain_order_jobs older
           WHERE older.order_id = j.order_id AND older.id < j.id AND older.tx_hash IS NULL)
       ORDER BY j.id LIMIT 12`,
    );
    for (const job of jobs) {
      try {
        const proof = await serializeSigner(() => withLocalSigner(async ({ provider, deployment, wallet }) => {
          const registry = new Contract(deployment.address, deployment.abi, wallet);
          const filter = registry.filters.OrderAnchored(job.orderKey, job.digest);
          const logs = await registry.queryFilter(filter, deployment.registryBlockNumber ?? 0);
          const previous = logs.find((log) => Number(log.args?.status) === job.status);
          const txHash = previous?.transactionHash
            ?? await sendTransaction(provider, wallet, registry, "anchorOrder", [job.orderKey, job.digest, job.status]);
          return { txHash, epoch: deployment.registryBlockHash };
        }));
        await saveProof(job, proof.txHash, proof.epoch);
      } catch {
        const retrySeconds = Math.min(60, 2 ** Math.min(6, job.attempts + 1));
        await pool.execute(
          `UPDATE blockchain_order_jobs
           SET attempts = LEAST(attempts + 1, 65535), retry_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP) WHERE id = ?`,
          [retrySeconds, job.id],
        );
      }
    }
  } catch {
    automationStatus = { ready: false, message: unavailable };
  } finally { processing = false; }
}

export function startBlockchainAutomation() {
  void processProofJobs();
  setInterval(processProofJobs, 2500).unref();
}
