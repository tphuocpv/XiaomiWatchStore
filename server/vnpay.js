import { createHmac, timingSafeEqual } from "node:crypto";

function localDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

function sortedQuery(params) {
  return new URLSearchParams([...params.entries()].sort(([a], [b]) => a.localeCompare(b))).toString();
}

function sign(params, secret) {
  return createHmac("sha512", secret).update(sortedQuery(params), "utf8").digest("hex");
}

export function hasVnpayCredentials() {
  return Boolean(process.env.VNPAY_TMN_CODE?.trim() && process.env.VNPAY_HASH_SECRET?.trim());
}

export function createVnpayUrl({ orderCode, amountVnd, clientIp }) {
  const tmnCode = process.env.VNPAY_TMN_CODE?.trim();
  const secret = process.env.VNPAY_HASH_SECRET?.trim();
  if (!tmnCode || !secret) throw new Error("VNPay sandbox chưa được cấu hình TmnCode và HashSecret.");

  const params = new URLSearchParams([
    ["vnp_Version", "2.1.0"],
    ["vnp_Command", "pay"],
    ["vnp_TmnCode", tmnCode],
    ["vnp_Amount", String(Math.round(Number(amountVnd) * 100))],
    ["vnp_CurrCode", "VND"],
    ["vnp_TxnRef", orderCode],
    ["vnp_OrderInfo", `Thanh toan don hang ${orderCode}`],
    ["vnp_OrderType", "other"],
    ["vnp_Locale", "vn"],
    ["vnp_ReturnUrl", process.env.VNPAY_RETURN_URL || "http://127.0.0.1:3000/api/payments/vnpay/return"],
    ["vnp_IpAddr", clientIp || "127.0.0.1"],
    ["vnp_CreateDate", localDateTime()],
    ["vnp_ExpireDate", localDateTime(new Date(Date.now() + 15 * 60 * 1000))],
  ]);
  const hash = sign(params, secret);
  params.set("vnp_SecureHash", hash);
  const base = process.env.VNPAY_URL || "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";
  return `${base}?${params.toString()}`;
}

export function verifyVnpayQuery(searchParams) {
  const secret = process.env.VNPAY_HASH_SECRET?.trim();
  const received = searchParams.get("vnp_SecureHash");
  if (!secret || !received || !/^[a-f0-9]{128}$/i.test(received)) return false;
  const params = new URLSearchParams();
  const seen = new Set();
  for (const [key, value] of searchParams.entries()) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key !== "vnp_SecureHash" && key !== "vnp_SecureHashType") params.append(key, value);
  }
  const expected = Buffer.from(sign(params, secret), "hex");
  const actual = Buffer.from(received, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function vnPayNow() {
  return localDateTime();
}
