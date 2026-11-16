import { AbiCoder, Interface, Wallet, formatEther, getAddress, getBytes, keccak256, verifyMessage } from "ethers";
import { readFile } from "node:fs/promises";
import { chainId } from "../local-network.js";

const hashPattern = /^0x[a-fA-F0-9]{64}$/;

export class CryptoTransactionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CryptoTransactionError";
    this.code = code;
  }
}

export function cryptoExchangeRate() {
  const rate = BigInt(process.env.CRYPTO_ETH_VND_RATE || "100000000");
  if (rate <= 0n) throw new Error("CRYPTO_ETH_VND_RATE phải lớn hơn 0.");
  return rate;
}

export function quoteCryptoWei(totalVnd) {
  const rate = cryptoExchangeRate();
  const numerator = BigInt(totalVnd) * 10n ** 18n;
  return ((numerator + rate - 1n) / rate).toString();
}

export function formatCryptoWei(amountWei) {
  return formatEther(BigInt(amountWei));
}

export async function signCryptoQuote({ orderKey, invoiceHash, amountWei, deadline, deployment }) {
  const privateKey = process.env.CRYPTO_QUOTE_PRIVATE_KEY?.trim();
  if (!privateKey) throw new CryptoTransactionError("Chưa tạo khóa ký báo giá local. Hãy chạy setup local rồi triển khai lại hợp đồng.");
  let wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch {
    throw new CryptoTransactionError("Khóa ký báo giá trong .env chưa hợp lệ. Hãy chạy lại setup local.");
  }
  if (wallet.address.toLowerCase() !== deployment.quoteSigner.toLowerCase()) {
    throw new CryptoTransactionError("Khóa ký báo giá không khớp hợp đồng. Hãy chạy lại deploy:local.");
  }
  const quoteHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "uint256", "uint256", "uint256", "address"],
    [orderKey, invoiceHash, amountWei, deadline, chainId, deployment.escrow.address],
  ));
  const signature = await wallet.signMessage(getBytes(quoteHash));
  return { signature, deadline };
}

export async function loadCryptoDeployment(fileUrl) {
  let deployment;
  try {
    deployment = JSON.parse(await readFile(fileUrl, "utf8"));
  } catch {
    throw new CryptoTransactionError("Chưa triển khai hợp đồng thanh toán local. Hãy chạy deploy:local.");
  }
  if (Number(deployment.chainId) !== chainId || !deployment.escrow?.address || !Array.isArray(deployment.escrow?.abi)) {
    throw new CryptoTransactionError("Cấu hình hợp đồng thanh toán chưa đúng mạng LabChain Local.");
  }
  try {
    deployment.admin = getAddress(deployment.admin);
    deployment.merchant = getAddress(deployment.merchant ?? deployment.admin);
    deployment.escrow.address = getAddress(deployment.escrow.address);
    deployment.quoteSigner = getAddress(deployment.quoteSigner);
  } catch {
    throw new CryptoTransactionError("Địa chỉ hợp đồng thanh toán chưa hợp lệ.");
  }
  return deployment;
}

export async function verifyEscrowTransaction({ provider, deployment, txHash, order, methodName, amountWei }) {
  if (typeof txHash !== "string" || !hashPattern.test(txHash)) {
    throw new CryptoTransactionError("Mã giao dịch không hợp lệ.");
  }
  const activeChainId = Number(await provider.send("eth_chainId", []));
  if (activeChainId !== chainId) throw new CryptoTransactionError("Máy chủ blockchain không ở Chain ID 31337.");
  if (await provider.getCode(deployment.escrow.address) === "0x") {
    throw new CryptoTransactionError("Không tìm thấy hợp đồng thanh toán trên mạng local. Hãy chạy lại deploy:local.");
  }

  const transaction = await provider.getTransaction(txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (methodName === "payOrder" && (!transaction && !receipt || receipt?.status === 0)) {
    throw new CryptoTransactionError("Giao dịch cũ không thành công hoặc không còn trên LabChain Local. Bấm thanh toán lại để tạo yêu cầu mới.", "CRYPTO_TX_RETRYABLE");
  }
  if (!transaction || !receipt || receipt.status !== 1
      || transaction.to?.toLowerCase() !== deployment.escrow.address.toLowerCase()) {
    throw new CryptoTransactionError("Giao dịch chưa xác nhận hoặc không gọi đúng hợp đồng thanh toán.");
  }

  const iface = new Interface(deployment.escrow.abi);
  let parsed;
  try {
    parsed = iface.parseTransaction({ data: transaction.data, value: transaction.value });
  } catch {
    throw new CryptoTransactionError("Không đọc được nội dung giao dịch trong hợp đồng thanh toán.");
  }
  if (parsed?.name !== methodName || parsed.args[0]?.toLowerCase() !== order.blockchainKey.toLowerCase()) {
    throw new CryptoTransactionError("Giao dịch không khớp với đơn hàng.");
  }

  if (methodName === "payOrder") {
    if (parsed.args[1].toLowerCase() !== order.blockchainDigest.toLowerCase()
        || BigInt(parsed.args[2]) !== BigInt(amountWei)
        || BigInt(transaction.value) !== BigInt(amountWei)) {
      throw new CryptoTransactionError("Số ETH hoặc mã băm hóa đơn không khớp với đơn hàng.");
    }
    const deadline = BigInt(parsed.args[3]);
    // payOrder enforces expiry at the time of mining; syncing can happen later.
    const quoteHash = keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "uint256", "uint256", "uint256", "address"],
      [order.blockchainKey, order.blockchainDigest, amountWei, deadline, chainId, deployment.escrow.address],
    ));
    if (verifyMessage(getBytes(quoteHash), parsed.args[4]).toLowerCase() !== deployment.quoteSigner.toLowerCase()) {
      throw new CryptoTransactionError("Chữ ký báo giá ETH không hợp lệ.");
    }
  } else if (transaction.from.toLowerCase() !== deployment.admin.toLowerCase() || BigInt(transaction.value) !== 0n) {
    throw new CryptoTransactionError("Giao dịch quản trị phải được ký từ ví admin và không gửi thêm ETH.");
  }

  const eventName = {
    payOrder: "PaymentEscrowed",
    markShipped: "OrderMarkedShipped",
    releaseOrder: "OrderReleased",
    refundOrder: "OrderRefunded",
    cancelUnpaidOrder: "OrderCancelled",
  }[methodName];
  let eventArgs = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== deployment.escrow.address.toLowerCase()) continue;
    try {
      const event = iface.parseLog(log);
      if (event?.name === eventName && event.args.orderKey.toLowerCase() === order.blockchainKey.toLowerCase()) {
        eventArgs = event.args;
        break;
      }
    } catch { /* Ignore logs emitted by other contracts. */ }
  }
  if (!eventArgs) throw new CryptoTransactionError("Receipt không có sự kiện xác nhận đúng đơn hàng.");

  if (methodName === "payOrder") {
    const buyer = getAddress(eventArgs.buyer);
    if (buyer.toLowerCase() !== transaction.from.toLowerCase()
        || BigInt(eventArgs.amount) !== BigInt(amountWei)
        || eventArgs.invoiceHash.toLowerCase() !== order.blockchainDigest.toLowerCase()) {
      throw new CryptoTransactionError("Sự kiện thanh toán không khớp ví khách hoặc hóa đơn.");
    }
    return { buyerAddress: buyer, txHash };
  }
  if (methodName === "releaseOrder" && (eventArgs.merchant.toLowerCase() !== (deployment.merchant ?? deployment.admin).toLowerCase()
      || BigInt(eventArgs.amount) !== BigInt(amountWei))) {
    throw new CryptoTransactionError("Sự kiện giải ngân không khớp số tiền escrow.");
  }
  if (methodName === "refundOrder" && (BigInt(eventArgs.amount) !== BigInt(amountWei)
      || (order.buyerAddress && eventArgs.buyer.toLowerCase() !== order.buyerAddress.toLowerCase()))) {
    throw new CryptoTransactionError("Sự kiện hoàn tiền không khớp ví khách hoặc số tiền escrow.");
  }
  return { txHash };
}
