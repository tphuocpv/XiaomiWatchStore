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
const unavailable = "Chưa kết nối được blockchain. Hệ thống sẽ tự thử lại.";
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
    "INSERT IGNORE INTO tac_vu_blockchain (ma_don_hang, trang_thai_don) VALUES (?, ?)",
    [orderId, orderStatusCode[status]],
  );
}

export async function persistEscrowPayment(orderId, payment) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[order]] = await connection.execute(
      `SELECT o.trang_thai_thanh_toan AS paymentStatus, o.trang_thai_don AS orderStatus,
        cp.trang_thai AS cryptoStatus, cp.ma_giao_dich_thanh_toan AS paymentTxHash
       FROM don_hang o JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma WHERE o.ma = ? FOR UPDATE`, [orderId],
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
      `UPDATE don_hang SET trang_thai_thanh_toan = 'paid',
        trang_thai_don = CASE WHEN trang_thai_don = 'pending' THEN 'confirmed' ELSE trang_thai_don END
       WHERE ma = ?`, [orderId],
    );
    await connection.execute(
      "UPDATE thanh_toan_eth SET trang_thai = 'escrowed', dia_chi_vi_khach = ?, ma_giao_dich_thanh_toan = ? WHERE ma_don_hang = ?",
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
    `INSERT IGNORE INTO tac_vu_blockchain (ma_don_hang, trang_thai_don)
     SELECT ma, FIELD(trang_thai_don, ?, ?, ?, ?, ?, ?) FROM don_hang
     WHERE khoa_don_blockchain IS NOT NULL AND ma_bam_hoa_don IS NOT NULL`, statuses,
  );
  await pool.execute(
    `UPDATE tac_vu_blockchain SET ma_giao_dich = NULL, so_lan_thu = 0, thu_lai_luc = CURRENT_TIMESTAMP,
      ma_phien_so_cai = NULL WHERE ma_giao_dich IS NOT NULL AND NOT (ma_phien_so_cai <=> ?)`, [deployment.registryBlockHash],
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
      `SELECT o.ma AS id, o.khoa_don_blockchain AS blockchainKey, o.ma_bam_hoa_don AS blockchainDigest,
         cp.so_tien_wei AS amountWei
       FROM don_hang o JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma
       WHERE o.khoa_don_blockchain = ? AND o.trang_thai_thanh_toan = 'unpaid' AND cp.trang_thai = 'unpaid'
         AND o.trang_thai_don IN ('pending', 'confirmed', 'packing') LIMIT 1`,
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
      "UPDATE don_hang SET ma_giao_dich_blockchain = ?, trang_thai_blockchain = ? WHERE ma = ? AND trang_thai_don = ?",
      [txHash, job.status, job.orderId, Object.keys(orderStatusCode)[job.status - 1]],
    );
    await connection.execute(
      "UPDATE tac_vu_blockchain SET ma_giao_dich = ?, ma_phien_so_cai = ?, so_lan_thu = 0 WHERE ma = ?",
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
      `SELECT j.ma AS id, j.ma_don_hang AS orderId, j.trang_thai_don AS status, j.so_lan_thu AS attempts,
        o.khoa_don_blockchain AS orderKey, o.ma_bam_hoa_don AS digest
       FROM tac_vu_blockchain j JOIN don_hang o ON o.ma = j.ma_don_hang
       WHERE j.ma_giao_dich IS NULL AND j.thu_lai_luc <= CURRENT_TIMESTAMP
         AND NOT EXISTS (SELECT 1 FROM tac_vu_blockchain older
           WHERE older.ma_don_hang = j.ma_don_hang AND older.ma < j.ma AND older.ma_giao_dich IS NULL)
       ORDER BY j.ma LIMIT 12`,
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
          `UPDATE tac_vu_blockchain
           SET so_lan_thu = LEAST(so_lan_thu + 1, 65535), thu_lai_luc = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP)
           WHERE ma = ?`,
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
