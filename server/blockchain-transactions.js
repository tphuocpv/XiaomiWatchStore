import { readFile } from "node:fs/promises";
import { FetchRequest, Interface, JsonRpcProvider, formatEther, formatUnits } from "ethers";
import { chainId, rpcUrl } from "../local-network.js";
import { pool } from "./db.js";

const deploymentFile = new URL("../public/deployment.json", import.meta.url);
const orderStatusLabels = ["Chờ xử lý", "Đã xác nhận", "Đang đóng gói", "Đang giao", "Đã giao", "Đã hủy"];
const methods = {
  payOrder: "Thanh toán ETH vào hợp đồng giữ tiền",
  markShipped: "Đánh dấu đơn đang giao",
  releaseOrder: "Giải ngân ETH cho cửa hàng",
  refundOrder: "Hoàn ETH về ví khách",
  cancelUnpaidOrder: "Khóa thanh toán của đơn đã hủy",
};

async function findMiTimeCall(transaction) {
  if (!transaction.to) return null;
  const deployment = await readFile(deploymentFile, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!deployment) return null;
  for (const item of [deployment, ...(deployment.previousDeployments ?? [])]) {
    const target = transaction.to.toLowerCase();
    const contract = item.address?.toLowerCase() === target ? item
      : item.escrow?.address?.toLowerCase() === target ? item.escrow : null;
    if (!contract?.abi) continue;
    const iface = new Interface(contract.abi);
    try {
      const call = iface.parseTransaction({ data: transaction.data, value: transaction.value });
      if (call) return { iface, call };
    } catch { /* Preserve the raw transaction details if the call cannot be decoded. */ }
  }
  return null;
}

function describeMovement(transaction, receipt, decoded) {
  if (receipt?.status !== 1) return null;
  if (decoded) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== transaction.to.toLowerCase()) continue;
      let event;
      try { event = decoded.iface.parseLog(log); } catch { continue; }
      if (!event || event.args.orderKey?.toLowerCase() !== decoded.call.args[0]?.toLowerCase()) continue;
      if (event.name === "PaymentEscrowed") return {
        amountEth: formatEther(event.args.amount), from: event.args.buyer, to: transaction.to,
        description: "Hợp đồng nhận ETH từ ví khách để giữ cho đơn.",
      };
      if (event.name === "OrderReleased") return {
        amountEth: formatEther(event.args.amount), from: transaction.to, to: event.args.merchant,
        description: "Hợp đồng chuyển khoản ETH của đơn vào ví nhận tiền của cửa hàng.",
      };
      if (event.name === "OrderRefunded") return {
        amountEth: formatEther(event.args.amount), from: transaction.to, to: event.args.buyer,
        description: "Hợp đồng hoàn khoản ETH của đơn về ví đã thanh toán.",
      };
    }
  }
  if (transaction.value > 0n && (receipt.to || receipt.contractAddress)) return {
    amountEth: formatEther(transaction.value), from: transaction.from, to: receipt.to || receipt.contractAddress,
    description: "Số ETH gửi kèm giao dịch.",
  };
  return null;
}

export async function readBlockchainTransaction(hash) {
  const rpc = new FetchRequest(rpcUrl);
  rpc.timeout = 4000;
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  try {
    const [rpcChainId, transaction] = await Promise.all([
      provider.send("eth_chainId", []), provider.getTransaction(hash),
    ]);
    if (Number(rpcChainId) !== chainId) throw new Error("Wrong chain");
    if (!transaction) return null;
    const [receipt, decoded] = await Promise.all([
      provider.getTransactionReceipt(hash), findMiTimeCall(transaction),
    ]);
    const blockNumber = receipt?.blockNumber ?? transaction.blockNumber;
    const block = blockNumber != null ? await provider.getBlock(blockNumber) : null;
    const call = decoded?.call;
    const invoiceHash = receipt?.status === 1 && ["payOrder", "anchorOrder"].includes(call?.name) ? call.args[1] : null;
    let action = !transaction.to ? "Triển khai hợp đồng"
      : transaction.data === "0x" ? "Chuyển ETH" : "Tương tác hợp đồng";
    let orderCode = null;
    let related = [];
    if (call?.name === "anchorOrder") {
      const label = orderStatusLabels[Number(call.args[2]) - 1];
      action = label ? `Ghi trạng thái đơn “${label}”` : "Ghi trạng thái đơn";
    } else if (call && methods[call.name]) {
      action = methods[call.name];
    }
    if (call && (call.name === "anchorOrder" || methods[call.name])) {
      try {
        const [[order]] = await pool.execute(
          `SELECT o.order_code AS orderCode, cp.payment_tx_hash AS paymentHash, cp.ship_tx_hash AS shippingHash,
            cp.release_tx_hash AS releaseHash, cp.refund_tx_hash AS refundHash, cp.cancel_tx_hash AS cancellationHash,
            o.blockchain_tx_hash AS proofHash
           FROM orders o LEFT JOIN crypto_payments cp ON cp.order_id = o.id WHERE o.blockchain_key = ? LIMIT 1`,
          [call.args[0]],
        );
        orderCode = order?.orderCode ?? null;
        if (order) {
          const links = [
            [order.paymentHash, "Thanh toán ETH"], [order.shippingHash, "Đánh dấu đang giao"],
            [order.releaseHash, "Giải ngân cho cửa hàng"], [order.refundHash, "Hoàn ETH về ví khách"],
            [order.cancellationHash, "Khóa thanh toán"], [order.proofHash, "Bằng chứng trạng thái gần nhất"],
          ];
          const seen = new Set([hash.toLowerCase()]);
          for (const [otherHash, label] of links) {
            if (!otherHash || seen.has(otherHash.toLowerCase())) continue;
            seen.add(otherHash.toLowerCase());
            related.push({ hash: otherHash, label });
          }
        }
      } catch {
        // Chain details are still available if MySQL cannot link the order.
      }
    }
    return {
      hash: transaction.hash, chainId, status: receipt ? (receipt.status === 1 ? "confirmed" : "failed") : "pending",
      blockNumber, timestamp: block ? new Date(block.timestamp * 1000).toISOString() : null,
      from: transaction.from, to: transaction.to ?? receipt?.contractAddress ?? null, nonce: transaction.nonce,
      gasUsed: receipt?.gasUsed.toString() ?? null,
      gasPriceGwei: receipt ? formatUnits(receipt.gasPrice, "gwei") : null,
      feeEth: receipt ? formatEther(receipt.fee) : null,
      valueEth: formatEther(transaction.value), action, orderCode, invoiceHash, related,
      movement: describeMovement(transaction, receipt, decoded),
    };
  } finally {
    provider.destroy();
  }
}
