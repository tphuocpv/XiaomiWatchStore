import "dotenv/config";
import bcrypt from "bcryptjs";
import express from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import helmet from "helmet";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FetchRequest, Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { chainId, rpcUrl } from "../local-network.js";
import { pool } from "./db.js";
import { CryptoTransactionError, cryptoExchangeRate, formatCryptoWei, loadCryptoDeployment, quoteCryptoWei, signCryptoQuote, verifyEscrowTransaction } from "./crypto-payments.js";
import { canDeclineEscrowCancellation, enqueueOrderProof, getBlockchainAutomationStatus, orderStatusCode, persistEscrowPayment, recordEscrowAction, startBlockchainAutomation } from "./blockchain-automation.js";
import { readBlockchainTransaction } from "./blockchain-transactions.js";
import { createVnpayUrl, hasVnpayCredentials, verifyVnpayQuery } from "./vnpay.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const sessionSecret = process.env.SESSION_SECRET;
const deploymentFile = new URL("../public/deployment.json", import.meta.url);
const allowedOrderStatuses = new Set(Object.keys(orderStatusCode));
const orderTransitions = {
  pending: new Set(["pending", "confirmed", "cancelled"]),
  confirmed: new Set(["confirmed", "packing", "cancelled"]),
  packing: new Set(["packing", "shipped", "cancelled"]),
  shipped: new Set(["shipped", "delivered"]),
  delivered: new Set(["delivered"]),
  cancelled: new Set(["cancelled"]),
};

if (!sessionSecret || sessionSecret.length < 24) {
  console.error("Tạo .env từ .env.example và đặt SESSION_SECRET dài ít nhất 24 ký tự.");
  process.exit(1);
}

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], imgSrc: ["'self'", "data:"], styleSrc: ["'self'"],
    styleSrcAttr: ["'unsafe-inline'"],
    scriptSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"],
    baseUri: ["'self'"], formAction: ["'self'"],
  } },
}));
app.use(express.json({ limit: "32kb" }));
app.use(session({
  name: "miwatch.sid", secret: sessionSecret, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 8 * 60 * 60 * 1000 },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-8", legacyHeaders: false,
  message: { error: "Bạn thử đăng nhập quá nhiều lần. Hãy chờ một lúc rồi thử lại." },
});

function requireUser(request, response, next) {
  if (!request.session.user) return response.status(401).json({ error: "Đăng nhập để tiếp tục." });
  next();
}

function requireAdmin(request, response, next) {
  if (request.session.user?.role !== "admin") {
    return response.status(403).json({ error: "Chức năng này chỉ dành cho admin." });
  }
  next();
}

function publicUser(user) {
  return {
    id: user.id, fullName: user.full_name, username: user.username, role: user.role,
    phone: user.phone ?? "", email: user.email ?? "", address: user.address ?? "",
  };
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validPhone(value) {
  return /^[+\d ()-]{8,24}$/.test(value);
}

function makeOrderCode() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", year: "2-digit", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}${values.month}${values.day}`;
  return `MW${date}${randomBytes(4).toString("hex").toUpperCase()}`;
}

function makeVnpayReference(orderCode) {
  return `${orderCode}${randomBytes(3).toString("hex").toUpperCase()}`;
}

function productSlug(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "d")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 190);
}

function parseVnpayRequest(request) {
  const search = new URL(request.originalUrl, "http://127.0.0.1").searchParams;
  const valid = verifyVnpayQuery(search)
    && search.get("vnp_TmnCode") === process.env.VNPAY_TMN_CODE?.trim();
  return { search, valid };
}

async function applyVnpayResult(search) {
  const transactionRef = cleanText(search.get("vnp_TxnRef"), 32);
  const [rows] = await pool.execute(
    `SELECT o.ma AS id, o.ma_don AS orderCode, o.tong_tien_vnd AS totalVnd,
        o.phuong_thuc_thanh_toan AS paymentMethod, o.trang_thai_don AS orderStatus
     FROM lan_thanh_toan pa JOIN don_hang o ON o.ma = pa.ma_don_hang
     WHERE pa.ma_tham_chieu = ? AND pa.nha_cung_cap = 'vnpay' LIMIT 1`,
    [transactionRef],
  );
  const order = rows[0];
  if (!order || order.paymentMethod !== "vnpay") return { found: false };
  if (Number(search.get("vnp_Amount")) !== Number(order.totalVnd) * 100) return { found: true, invalidAmount: true, orderCode: order.orderCode };

  const success = search.get("vnp_ResponseCode") === "00" && search.get("vnp_TransactionStatus") === "00";
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [lockedRows] = await connection.execute(
      "SELECT trang_thai_thanh_toan AS paymentStatus, trang_thai_don AS orderStatus FROM don_hang WHERE ma = ? FOR UPDATE", [order.id],
    );
    const locked = lockedRows[0];
    const status = locked?.paymentStatus;
    if (status === "paid") {
      if (success) {
        await connection.execute(
          "UPDATE lan_thanh_toan SET ma_phan_hoi = '00', chu_ky_hop_le = TRUE WHERE ma_tham_chieu = ?",
          [transactionRef],
        );
      }
      await connection.commit();
      return {
        found: true, alreadyPaid: true, success: true,
        latePayment: locked.orderStatus === "cancelled", orderCode: order.orderCode,
      };
    }
    if (status === "refunded") {
      await connection.commit();
      return { found: true, success: false, terminal: true, orderCode: order.orderCode };
    }
    if (success) {
      await connection.execute(
        "UPDATE don_hang SET trang_thai_thanh_toan = 'paid', trang_thai_don = CASE WHEN trang_thai_don = 'cancelled' THEN 'cancelled' ELSE 'confirmed' END WHERE ma = ?", [order.id],
      );
      if (locked.orderStatus !== "cancelled") await enqueueOrderProof(connection, order.id, "confirmed");
    } else {
      await connection.execute("UPDATE don_hang SET trang_thai_thanh_toan = 'failed' WHERE ma = ?", [order.id]);
    }
    await connection.execute(
      "UPDATE lan_thanh_toan SET ma_phan_hoi = ?, chu_ky_hop_le = TRUE WHERE ma_tham_chieu = ?",
      [search.get("vnp_ResponseCode"), transactionRef],
    );
    await connection.commit();
    return {
      found: true, success,
      latePayment: success && locked?.orderStatus === "cancelled", orderCode: order.orderCode,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({
      status: "ok", mysql: "connected", vnpaySandboxConfigured: hasVnpayCredentials(),
      cryptoEthVndRate: cryptoExchangeRate().toString(), cryptoChainId: chainId,
    });
  } catch {
    response.status(503).json({ status: "needs-setup", mysql: "disconnected", vnpaySandboxConfigured: hasVnpayCredentials() });
  }
});

app.get("/api/categories", async (_request, response) => {
  try {
    const [rows] = await pool.execute("SELECT ma AS id, ten AS name, ten_duong_dan AS slug, mo_ta AS description FROM danh_muc ORDER BY ten");
    response.json({ categories: rows });
  } catch {
    response.status(503).json({ error: "MySQL chưa sẵn sàng. Hãy khởi động MySQL và nhập schema." });
  }
});

app.get("/api/products", async (request, response) => {
  try {
    const search = cleanText(request.query.search, 100);
    const category = cleanText(request.query.category, 120);
    const conditions = ["p.dang_hoat_dong = TRUE"];
    const values = [];
    if (search) {
      conditions.push("(p.ten LIKE ? OR p.mo_ta_ngan LIKE ?)");
      values.push(`%${search}%`, `%${search}%`);
    }
    if (category) {
      conditions.push("c.ten_duong_dan = ?");
      values.push(category);
    }
    const [rows] = await pool.execute(
      `SELECT p.ma AS id, p.ten AS name, p.ten_duong_dan AS slug, p.mo_ta_ngan AS shortDescription,
              p.thong_so AS specifications, p.gia_vnd AS priceVnd,
              p.gia_niem_yet_vnd AS compareAtVnd, p.ton_kho AS stock,
              p.duong_dan_anh AS imageUrl, c.ten AS categoryName, c.ten_duong_dan AS categorySlug
       FROM san_pham p JOIN danh_muc c ON c.ma = p.ma_danh_muc
       WHERE ${conditions.join(" AND ")} ORDER BY p.ma`, values,
    );
    response.json({ products: rows });
  } catch {
    response.status(503).json({ error: "Chưa đọc được sản phẩm từ MySQL." });
  }
});

app.post("/api/auth/register", async (request, response) => {
  const fullName = cleanText(request.body?.fullName, 120);
  const phone = cleanText(request.body?.phone, 24);
  const email = cleanText(request.body?.email, 190).toLowerCase();
  const username = cleanText(request.body?.username, 64);
  const address = cleanText(request.body?.address, 500);
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  if (!fullName || !validPhone(phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !address
      || !/^[a-zA-Z0-9_.-]{4,64}$/.test(username) || password.length < 8 || password.length > 128) {
    return response.status(400).json({ error: "Kiểm tra lại họ tên, số điện thoại, email, địa chỉ, tên đăng nhập và mật khẩu." });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute(
      "INSERT INTO nguoi_dung (ho_ten, so_dien_thoai, thu_dien_tu, ten_dang_nhap, dia_chi, mat_khau_bam) VALUES (?, ?, ?, ?, ?, ?)",
      [fullName, phone, email, username, address, hash],
    );
    await new Promise((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
    request.session.user = publicUser({ id: result.insertId, full_name: fullName, phone, email, username, address, role: "customer" });
    response.status(201).json({ user: request.session.user });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return response.status(409).json({ error: "Tên đăng nhập, email hoặc số điện thoại đã được dùng." });
    response.status(503).json({ error: "Chưa lưu được tài khoản. Kiểm tra MySQL." });
  }
});

app.post("/api/auth/login", loginLimiter, async (request, response) => {
  const username = cleanText(request.body?.username, 190);
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  try {
    const [rows] = await pool.execute(
      "SELECT ma AS id, ho_ten AS full_name, so_dien_thoai AS phone, thu_dien_tu AS email, dia_chi AS address, ten_dang_nhap AS username, mat_khau_bam AS password_hash, vai_tro AS role FROM nguoi_dung WHERE ten_dang_nhap = ? OR thu_dien_tu = ? LIMIT 1",
      [username, username.toLowerCase()],
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return response.status(401).json({ error: "Tên đăng nhập hoặc mật khẩu chưa đúng." });
    }
    await new Promise((resolve, reject) => request.session.regenerate((error) => error ? reject(error) : resolve()));
    request.session.user = publicUser(user);
    response.json({ user: request.session.user });
  } catch {
    response.status(503).json({ error: "Chưa đăng nhập được. Kiểm tra MySQL." });
  }
});

app.get("/api/auth/me", (request, response) => response.json({ user: request.session.user ?? null }));

app.post("/api/auth/logout", (request, response) => {
  request.session.destroy((error) => {
    if (error) return response.status(500).json({ error: "Chưa đăng xuất được." });
    response.clearCookie("miwatch.sid", { httpOnly: true, sameSite: "lax" });
    response.json({ ok: true });
  });
});

app.post("/api/orders", requireUser, async (request, response) => {
  const shippingName = cleanText(request.body?.shippingName, 120);
  const shippingPhone = cleanText(request.body?.shippingPhone, 24);
  const shippingAddress = cleanText(request.body?.shippingAddress, 500);
  const paymentMethod = request.body?.paymentMethod;
  const note = cleanText(request.body?.customerNote, 500);
  const requested = request.body?.items;
  if (!shippingName || !validPhone(shippingPhone) || !shippingAddress || !["cod", "vnpay", "crypto"].includes(paymentMethod)
      || !Array.isArray(requested) || requested.length < 1 || requested.length > 20) {
    return response.status(400).json({ error: "Kiểm tra thông tin nhận hàng, cách thanh toán và sản phẩm trong giỏ." });
  }
  if (paymentMethod === "vnpay" && !hasVnpayCredentials()) {
    return response.status(503).json({ error: "Thanh toán VNPay hiện chưa khả dụng. Bạn vẫn có thể chọn thanh toán khi nhận hàng." });
  }
  const quantities = new Map();
  for (const item of requested) {
    const id = Number(item?.productId);
    const quantity = Number(item?.quantity);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) {
      return response.status(400).json({ error: "Số lượng sản phẩm trong giỏ không hợp lệ." });
    }
    quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  }
  if ([...quantities.values()].some((quantity) => quantity > 10)) {
    return response.status(400).json({ error: "Mỗi mẫu chỉ được đặt tối đa 10 chiếc." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const items = [];
    let subtotal = 0;
    for (const [productId, quantity] of [...quantities.entries()].sort(([a], [b]) => a - b)) {
      const [rows] = await connection.execute(
        "SELECT ma AS id, ten AS name, gia_vnd AS priceVnd, ton_kho AS stock FROM san_pham WHERE ma = ? AND dang_hoat_dong = TRUE FOR UPDATE", [productId],
      );
      const product = rows[0];
      if (!product) throw Object.assign(new Error("Một sản phẩm không còn được bán."), { status: 409 });
      if (Number(product.stock) < quantity) throw Object.assign(new Error(`Mẫu ${product.name} không đủ tồn kho.`), { status: 409 });
      const unitPrice = Number(product.priceVnd);
      subtotal += unitPrice * quantity;
      items.push({ productId: product.id, productName: product.name, unitPrice, quantity });
      await connection.execute("UPDATE san_pham SET ton_kho = ton_kho - ? WHERE ma = ?", [quantity, product.id]);
    }
    const orderCode = makeOrderCode();
    const transactionRef = paymentMethod === "vnpay" ? makeVnpayReference(orderCode) : null;
    const cryptoAmountWei = paymentMethod === "crypto" ? quoteCryptoWei(subtotal) : null;
    const createdAt = new Date();
    if (paymentMethod === "vnpay" && subtotal < 5000) {
      throw Object.assign(new Error("VNPay yêu cầu thanh toán tối thiểu 5.000 ₫."), { status: 400 });
    }
    const orderKey = keccak256(toUtf8Bytes(orderCode));
    const digestPayload = JSON.stringify({
      orderCode, totalVnd: subtotal, paymentMethod,
      items: items.map(({ productId, productName, unitPrice, quantity }) => ({ productId, productName, unitPrice, quantity })),
      createdAt: createdAt.toISOString(),
    });
    const orderDigest = keccak256(toUtf8Bytes(digestPayload));
    const [insert] = await connection.execute(
      `INSERT INTO don_hang
        (ma_don, ma_nguoi_dung, tam_tinh_vnd, phi_giao_hang_vnd, tong_tien_vnd, phuong_thuc_thanh_toan,
         trang_thai_don, ten_nguoi_nhan, so_dien_thoai_nhan, dia_chi_nhan, ghi_chu_khach,
         khoa_don_blockchain, ma_bam_hoa_don, tao_luc)
       VALUES (?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [orderCode, request.session.user.id, subtotal, subtotal, paymentMethod,
        shippingName, shippingPhone, shippingAddress, note || null, orderKey, orderDigest, createdAt],
    );
    for (const item of items) {
      await connection.execute(
        "INSERT INTO chi_tiet_don_hang (ma_don_hang, ma_san_pham, ten_san_pham, don_gia_vnd, so_luong) VALUES (?, ?, ?, ?, ?)",
        [insert.insertId, item.productId, item.productName, item.unitPrice, item.quantity],
      );
    }
    await enqueueOrderProof(connection, insert.insertId, "pending");
    if (paymentMethod === "crypto") {
      await connection.execute(
        "INSERT INTO thanh_toan_eth (ma_don_hang, ma_mang, so_tien_wei) VALUES (?, ?, ?)",
        [insert.insertId, chainId, cryptoAmountWei],
      );
    }
    let paymentUrl = null;
    if (paymentMethod === "vnpay") {
      await connection.execute(
        "INSERT INTO lan_thanh_toan (ma_don_hang, nha_cung_cap, ma_tham_chieu) VALUES (?, 'vnpay', ?)",
        [insert.insertId, transactionRef],
      );
      paymentUrl = createVnpayUrl({ orderCode: transactionRef, amountVnd: subtotal, clientIp: request.ip || "127.0.0.1" });
    }
    await connection.commit();
    response.status(201).json({
      order: {
        id: insert.insertId, orderCode, totalVnd: subtotal, paymentMethod, paymentStatus: "unpaid", orderStatus: "pending",
        ...(paymentMethod === "crypto" ? {
          cryptoAmountWei, cryptoAmountEth: formatCryptoWei(cryptoAmountWei), blockchainKey: orderKey, blockchainDigest: orderDigest,
        } : {}),
      },
      paymentUrl,
    });
  } catch (error) {
    await connection.rollback();
    response.status(error.status ?? 503).json({ error: error.status ? error.message : "Chưa tạo được đơn. Kiểm tra lại MySQL rồi thử lại." });
  } finally {
    connection.release();
  }
});

app.post("/api/orders/:id/payments/vnpay/retry", requireUser, async (request, response) => {
  if (!hasVnpayCredentials()) {
    return response.status(503).json({ error: "Thanh toán VNPay hiện chưa khả dụng. Vui lòng chọn thanh toán khi nhận hàng." });
  }
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Đơn hàng không hợp lệ." });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT ma_don AS orderCode, tong_tien_vnd AS totalVnd, phuong_thuc_thanh_toan AS paymentMethod,
        trang_thai_thanh_toan AS paymentStatus, trang_thai_don AS orderStatus,
        yeu_cau_huy_luc AS cancellationRequestedAt
       FROM don_hang WHERE ma = ? AND ma_nguoi_dung = ? FOR UPDATE`, [id, request.session.user.id],
    );
    const order = rows[0];
    if (!order) {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    }
    if (order.paymentMethod !== "vnpay") {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn hàng này không sử dụng VNPay." });
    }
    if (!["unpaid", "failed"].includes(order.paymentStatus)
        || ["cancelled", "shipped", "delivered"].includes(order.orderStatus)
        || order.cancellationRequestedAt) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn hàng hiện không thể thanh toán lại." });
    }
    const [activeAttempts] = await connection.execute(
      `SELECT ma AS id FROM lan_thanh_toan
       WHERE ma_don_hang = ? AND nha_cung_cap = 'vnpay' AND ma_phan_hoi IS NULL
         AND tao_luc >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)
       LIMIT 1 FOR UPDATE`, [id],
    );
    if (activeAttempts.length) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn vẫn còn phiên VNPay đang mở. Hãy hoàn tất hoặc chờ tối đa 15 phút rồi thanh toán lại." });
    }
    const transactionRef = makeVnpayReference(order.orderCode);
    const paymentUrl = createVnpayUrl({ orderCode: transactionRef, amountVnd: order.totalVnd, clientIp: request.ip || "127.0.0.1" });
    await connection.execute(
      "INSERT INTO lan_thanh_toan (ma_don_hang, nha_cung_cap, ma_tham_chieu) VALUES (?, 'vnpay', ?)", [id, transactionRef],
    );
    if (order.paymentStatus === "failed") {
      await connection.execute("UPDATE don_hang SET trang_thai_thanh_toan = 'unpaid' WHERE ma = ?", [id]);
    }
    await connection.commit();
    response.json({ paymentUrl });
  } catch (error) {
    await connection.rollback();
    response.status(error.status ?? 503).json({ error: error.status ? error.message : "Chưa tạo được liên kết thanh toán. Vui lòng thử lại." });
  } finally {
    connection.release();
  }
});

app.post("/api/orders/:id/payments/crypto/retry", requireUser, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Đơn hàng không hợp lệ." });
  let provider;
  try {
    const [rows] = await pool.execute(
      `SELECT o.ma_don AS orderCode, o.phuong_thuc_thanh_toan AS paymentMethod,
        o.trang_thai_thanh_toan AS paymentStatus, o.trang_thai_don AS orderStatus,
        o.yeu_cau_huy_luc AS cancellationRequestedAt, o.khoa_don_blockchain AS blockchainKey,
        o.ma_bam_hoa_don AS blockchainDigest, cp.so_tien_wei AS amountWei, cp.trang_thai AS cryptoStatus
       FROM don_hang o JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma
       WHERE o.ma = ? AND o.ma_nguoi_dung = ? LIMIT 1`, [id, request.session.user.id],
    );
    const order = rows[0];
    if (!order) return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    if (order.paymentMethod !== "crypto") return response.status(409).json({ error: "Đơn hàng này không dùng phương thức thanh toán ETH." });
    if (!['unpaid', 'failed'].includes(order.paymentStatus) || order.cryptoStatus !== "unpaid"
        || ["cancelled", "shipped", "delivered"].includes(order.orderStatus) || order.cancellationRequestedAt) {
      return response.status(409).json({ error: "Đơn hàng hiện không thể thanh toán lại." });
    }
    const deployment = await loadCryptoDeployment(deploymentFile);
    provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    if (Number(await provider.send("eth_chainId", [])) !== chainId
        || await provider.getCode(deployment.escrow.address) === "0x") {
      return response.status(503).json({ error: "Thanh toán bằng ETH hiện chưa khả dụng. Vui lòng thử lại sau." });
    }
    const deadline = Math.floor(Date.now() / 1000) + 30 * 60;
    const quote = await signCryptoQuote({
      orderKey: order.blockchainKey, invoiceHash: order.blockchainDigest,
      amountWei: order.amountWei, deadline, deployment,
    });
    response.json({
      orderCode: order.orderCode, orderKey: order.blockchainKey, invoiceHash: order.blockchainDigest,
      amountWei: order.amountWei, amountEth: formatCryptoWei(order.amountWei),
      chainId, contractAddress: deployment.escrow.address, signature: quote.signature, deadline: quote.deadline,
    });
  } catch {
    response.status(503).json({ error: "Chưa mở được thanh toán ETH. Vui lòng thử lại sau." });
  } finally {
    provider?.destroy();
  }
});

app.post("/api/orders/:id/payments/crypto/confirm", requireUser, async (request, response) => {
  const id = Number(request.params.id);
  const txHash = cleanText(request.body?.txHash, 66);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Đơn hàng không hợp lệ." });
  let provider;
  try {
    const [rows] = await pool.execute(
      `SELECT o.ma_don AS orderCode, o.trang_thai_thanh_toan AS paymentStatus, o.trang_thai_don AS orderStatus,
        o.khoa_don_blockchain AS blockchainKey, o.ma_bam_hoa_don AS blockchainDigest,
        cp.so_tien_wei AS amountWei, cp.ma_giao_dich_thanh_toan AS paymentTxHash, cp.trang_thai AS cryptoStatus
       FROM don_hang o JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma
       WHERE o.ma = ? AND o.ma_nguoi_dung = ? AND o.phuong_thuc_thanh_toan = 'crypto' LIMIT 1`, [id, request.session.user.id],
    );
    const order = rows[0];
    if (!order) return response.status(404).json({ error: "Không tìm thấy đơn hàng thanh toán bằng ETH." });
    if (order.paymentStatus === "paid" && order.paymentTxHash?.toLowerCase() === txHash.toLowerCase()) {
      return response.json({ ok: true, txHash, alreadyConfirmed: true });
    }
    if (order.paymentStatus !== "unpaid" || order.cryptoStatus !== "unpaid"
        || ["cancelled", "shipped", "delivered"].includes(order.orderStatus)) {
      return response.status(409).json({ error: "Trạng thái đơn hiện không nhận thêm giao dịch thanh toán." });
    }
    const deployment = await loadCryptoDeployment(deploymentFile);
    provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    const payment = await verifyEscrowTransaction({
      provider, deployment, txHash, order, methodName: "payOrder", amountWei: order.amountWei,
    });
    const { alreadyConfirmed } = await persistEscrowPayment(id, payment);
    response.json({ ok: true, txHash, alreadyConfirmed });
  } catch (error) {
    const status = error.status ?? (error instanceof CryptoTransactionError ? 400 : 503);
    const message = status < 500 ? error.message : "Chưa xác minh được thanh toán ETH. Vui lòng thử lại sau.";
    response.status(status).json({ error: message, code: status === 400 ? error.code : undefined });
  } finally {
    provider?.destroy();
  }
});

app.post("/api/orders/:id/cancellation-request", requireUser, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Đơn hàng không hợp lệ." });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT trang_thai_don AS orderStatus, yeu_cau_huy_luc AS cancellationRequestedAt
       FROM don_hang WHERE ma = ? AND ma_nguoi_dung = ? FOR UPDATE`, [id, request.session.user.id],
    );
    const order = rows[0];
    if (!order) {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    }
    if (!["pending", "confirmed", "packing"].includes(order.orderStatus)) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn hàng đã chuyển sang giao hàng nên không thể gửi yêu cầu hủy." });
    }
    if (!order.cancellationRequestedAt) {
      await connection.execute("UPDATE don_hang SET yeu_cau_huy_luc = CURRENT_TIMESTAMP WHERE ma = ?", [id]);
    }
    await connection.commit();
    response.json({ ok: true });
  } catch {
    await connection.rollback();
    response.status(503).json({ error: "Chưa gửi được yêu cầu hủy. Vui lòng thử lại." });
  } finally {
    connection.release();
  }
});

app.get("/api/orders", requireUser, async (request, response) => {
  try {
    const [orders] = await pool.execute(
      `SELECT o.ma AS id, o.ma_don AS orderCode, o.tong_tien_vnd AS totalVnd, o.phuong_thuc_thanh_toan AS paymentMethod,
        o.trang_thai_thanh_toan AS paymentStatus, o.trang_thai_don AS orderStatus,
        o.yeu_cau_huy_luc AS cancellationRequestedAt, o.tao_luc AS createdAt,
        (SELECT MAX(DATE_ADD(pa.tao_luc, INTERVAL 15 MINUTE))
         FROM lan_thanh_toan pa
         WHERE pa.ma_don_hang = o.ma AND pa.nha_cung_cap = 'vnpay' AND pa.ma_phan_hoi IS NULL) AS vnpayPendingUntil,
        cp.so_tien_wei AS cryptoAmountWei, cp.trang_thai AS cryptoStatus,
        cp.dia_chi_vi_khach AS cryptoBuyerAddress, cp.ma_giao_dich_thanh_toan AS cryptoPaymentTxHash,
        cp.ma_giao_dich_giao_hang AS cryptoShipTxHash, cp.ma_giao_dich_giai_ngan AS cryptoReleaseTxHash,
        cp.ma_giao_dich_hoan_tien AS cryptoRefundTxHash
       FROM don_hang o LEFT JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma
       WHERE o.ma_nguoi_dung = ? ORDER BY o.tao_luc DESC LIMIT 50`, [request.session.user.id],
    );
    const ordersWithItems = await attachOrderItems(orders);
    response.json({ orders: await attachOrderStatusHistory(ordersWithItems) });
  } catch {
    response.status(503).json({ error: "Chưa đọc được lịch sử đơn hàng." });
  }
});

async function attachOrderItems(orders) {
  if (!orders.length) return [];
  const ids = orders.map((order) => order.id);
  const placeholders = ids.map(() => "?").join(", ");
  const [items] = await pool.execute(
    `SELECT ma_don_hang AS orderId, ten_san_pham AS productName, don_gia_vnd AS unitPriceVnd, so_luong AS quantity
     FROM chi_tiet_don_hang WHERE ma_don_hang IN (${placeholders}) ORDER BY ma_don_hang, ma`, ids,
  );
  const byOrder = new Map();
  for (const item of items) {
    const key = String(item.orderId);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(item);
  }
  return orders.map((order) => ({ ...order, items: byOrder.get(String(order.id)) ?? [] }));
}

async function attachOrderStatusHistory(orders) {
  if (!orders.length) return [];
  const ids = orders.map((order) => order.id);
  const placeholders = ids.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `SELECT ma_don_hang AS orderId, trang_thai_don AS statusCode, ma_giao_dich AS txHash
     FROM tac_vu_blockchain
     WHERE ma_don_hang IN (${placeholders})
     ORDER BY ma_don_hang, trang_thai_don`, ids,
  );
  const statuses = Object.entries(orderStatusCode);
  const byOrder = new Map();
  for (const row of rows) {
    const status = statuses.find(([, code]) => code === Number(row.statusCode))?.[0];
    if (!status) continue;
    const key = String(row.orderId);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push({ status, statusCode: Number(row.statusCode), txHash: row.txHash, recorded: Boolean(row.txHash) });
  }
  return orders.map((order) => {
    const history = byOrder.get(String(order.id)) ?? [];
    const currentStatus = statuses.find(([status]) => status === order.orderStatus);
    if (currentStatus && !history.some((entry) => entry.status === order.orderStatus)) {
      history.push({ status: currentStatus[0], statusCode: currentStatus[1], txHash: null, recorded: false });
      history.sort((left, right) => left.statusCode - right.statusCode);
    }
    return { ...order, statusHistory: history };
  });
}

function registryReceiptMatches(receipt, deployment, iface, order, status) {
  if (receipt?.status !== 1 || !receipt.to || !order.blockchainKey || !order.blockchainDigest
      || receipt.to.toLowerCase() !== deployment.address.toLowerCase()
      || receipt.from.toLowerCase() !== deployment.admin.toLowerCase()) return false;
  return receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== receipt.to.toLowerCase()) return false;
    try {
      const event = iface.parseLog(log);
      return event?.name === "OrderAnchored"
        && event.args.orderKey.toLowerCase() === order.blockchainKey.toLowerCase()
        && event.args.orderDigest.toLowerCase() === order.blockchainDigest.toLowerCase()
        && Number(event.args.status) === status;
    } catch { return false; }
  });
}

async function checkStoredOrderProofs(orders) {
  const anchored = orders.filter((order) => order.blockchainTxHash);
  if (!anchored.length) return;
  const rpc = new FetchRequest(rpcUrl);
  rpc.timeout = 2500;
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  try {
    const deployment = JSON.parse(await readFile(deploymentFile, "utf8"));
    const [activeChain, code] = await Promise.all([
      provider.send("eth_chainId", []), provider.getCode(deployment.address),
    ]);
    if (Number(activeChain) !== chainId || code === "0x") throw new Error("Registry unavailable");
    const iface = new Interface(deployment.abi);
    await Promise.all(anchored.map(async (order) => {
      try {
        const receipt = await provider.getTransactionReceipt(order.blockchainTxHash);
        order.blockchainProof = registryReceiptMatches(receipt, deployment, iface, order, Number(order.blockchainStatus))
          ? "verified" : "missing";
      } catch {
        order.blockchainProof = "unavailable";
      }
    }));
  } catch {
    for (const order of anchored) order.blockchainProof = "unavailable";
  } finally {
    provider.destroy();
  }
}

app.get("/api/payments/vnpay/return", async (request, response) => {
  const { search, valid } = parseVnpayRequest(request);
  const transactionRef = cleanText(search.get("vnp_TxnRef"), 32);
  if (!valid) return response.redirect(`/?payment=invalid&order=${encodeURIComponent(transactionRef)}`);
  try {
    const result = await applyVnpayResult(search);
    const state = !result.found || result.invalidAmount ? "invalid"
      : result.latePayment ? "late" : result.success ? "success" : "failed";
    response.redirect(`/?payment=${state}&order=${encodeURIComponent(result.orderCode || transactionRef)}`);
  } catch {
    response.redirect(`/?payment=error&order=${encodeURIComponent(transactionRef)}`);
  }
});

app.get("/api/payments/vnpay/ipn", async (request, response) => {
  const { search, valid } = parseVnpayRequest(request);
  if (!valid) return response.json({ RspCode: "97", Message: "Chữ ký không hợp lệ" });
  try {
    const result = await applyVnpayResult(search);
    if (!result.found) return response.json({ RspCode: "01", Message: "Không tìm thấy đơn hàng" });
    if (result.invalidAmount) return response.json({ RspCode: "04", Message: "Số tiền không hợp lệ" });
    response.json({ RspCode: "00", Message: result.alreadyPaid ? "Order already confirmed" : "Confirm Success" });
  } catch {
    response.json({ RspCode: "99", Message: "Có lỗi chưa xác định" });
  }
});

app.get("/api/admin/orders", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [orders] = await pool.execute(
      `SELECT o.ma AS id, o.ma_don AS orderCode, o.tong_tien_vnd AS totalVnd, o.phuong_thuc_thanh_toan AS paymentMethod,
        o.trang_thai_thanh_toan AS paymentStatus, o.trang_thai_don AS orderStatus, o.ten_nguoi_nhan AS shippingName,
        o.so_dien_thoai_nhan AS shippingPhone, o.dia_chi_nhan AS shippingAddress,
        o.yeu_cau_huy_luc AS cancellationRequestedAt, o.khoa_don_blockchain AS blockchainKey,
        o.ma_bam_hoa_don AS blockchainDigest, o.ma_giao_dich_blockchain AS blockchainTxHash,
        o.trang_thai_blockchain AS blockchainStatus, o.tao_luc AS createdAt,
        CASE WHEN j.ma_giao_dich IS NULL AND j.ma IS NOT NULL THEN
          CASE WHEN j.so_lan_thu > 0 THEN 'error' ELSE 'pending' END
        ELSE NULL END AS blockchainSync,
        (SELECT MAX(DATE_ADD(pa.tao_luc, INTERVAL 15 MINUTE))
         FROM lan_thanh_toan pa
         WHERE pa.ma_don_hang = o.ma AND pa.nha_cung_cap = 'vnpay' AND pa.ma_phan_hoi IS NULL) AS vnpayPendingUntil,
        cp.so_tien_wei AS cryptoAmountWei, cp.trang_thai AS cryptoStatus,
        cp.dia_chi_vi_khach AS cryptoBuyerAddress, cp.ma_giao_dich_thanh_toan AS cryptoPaymentTxHash,
        cp.ma_giao_dich_giao_hang AS cryptoShipTxHash, cp.ma_giao_dich_giai_ngan AS cryptoReleaseTxHash,
        cp.ma_giao_dich_hoan_tien AS cryptoRefundTxHash,
        cp.ma_giao_dich_huy AS cryptoCancelTxHash
       FROM don_hang o LEFT JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma
       LEFT JOIN tac_vu_blockchain j ON j.ma_don_hang = o.ma
         AND j.trang_thai_don = FIELD(o.trang_thai_don, 'pending', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled')
       ORDER BY o.tao_luc DESC LIMIT 100`,
    );
    for (const order of orders) order.nextOrderStatuses = [...orderTransitions[order.orderStatus]];
    await checkStoredOrderProofs(orders);
    const ordersWithItems = await attachOrderItems(orders);
    response.json({
      orders: await attachOrderStatusHistory(ordersWithItems),
      blockchainAutomation: getBlockchainAutomationStatus(),
    });
  } catch {
    response.status(503).json({ error: "Chưa đọc được đơn hàng từ MySQL." });
  }
});

app.get("/api/admin/blockchain/transactions/:hash", requireUser, requireAdmin, async (request, response) => {
  const { hash } = request.params;
  response.set("Cache-Control", "no-store");
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return response.status(400).json({ error: "Hãy nhập mã giao dịch đầy đủ, bắt đầu bằng 0x và có 64 ký tự theo sau." });
  }
  try {
    const transaction = await readBlockchainTransaction(hash);
    if (!transaction) {
      return response.status(404).json({ error: "Không tìm thấy giao dịch trên LabChain Local hiện tại. Hãy kiểm tra mã và mạng đang dùng." });
    }
    response.json({ transaction });
  } catch {
    response.status(503).json({ error: "Chưa đọc được giao dịch trên blockchain. Vui lòng thử lại sau." });
  }
});

app.get("/api/admin/users", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [users] = await pool.execute(
      `SELECT u.ma AS id, u.ho_ten AS fullName, u.ten_dang_nhap AS username, u.so_dien_thoai AS phone, u.thu_dien_tu AS email, u.dia_chi AS address,
        u.tao_luc AS createdAt, COUNT(o.ma) AS orderCount
       FROM nguoi_dung u LEFT JOIN don_hang o ON o.ma_nguoi_dung = u.ma
       WHERE u.vai_tro = 'customer'
       GROUP BY u.ma, u.ho_ten, u.ten_dang_nhap, u.so_dien_thoai, u.thu_dien_tu, u.dia_chi, u.tao_luc
       ORDER BY u.tao_luc DESC LIMIT 500`,
    );
    response.json({ users });
  } catch {
    response.status(503).json({ error: "Chưa đọc được danh sách người dùng từ MySQL." });
  }
});

app.patch("/api/admin/users/:id", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  const fullName = cleanText(request.body?.fullName, 120);
  const phone = cleanText(request.body?.phone, 24);
  const email = cleanText(request.body?.email, 190).toLowerCase();
  const address = cleanText(request.body?.address, 500);
  if (!Number.isSafeInteger(id) || id < 1 || !fullName || !validPhone(phone)
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ error: "Kiểm tra họ tên, số điện thoại và email." });
  }
  try {
    const [result] = await pool.execute(
      "UPDATE nguoi_dung SET ho_ten = ?, so_dien_thoai = ?, thu_dien_tu = ?, dia_chi = ? WHERE ma = ? AND vai_tro = 'customer'",
      [fullName, phone, email, address || null, id],
    );
    if (result.affectedRows) return response.json({ ok: true });
    const [rows] = await pool.execute("SELECT ma AS id FROM nguoi_dung WHERE ma = ? AND vai_tro = 'customer' LIMIT 1", [id]);
    if (rows.length) return response.json({ ok: true });
    response.status(404).json({ error: "Không tìm thấy người dùng." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return response.status(409).json({ error: "Email hoặc số điện thoại đã được tài khoản khác sử dụng." });
    response.status(503).json({ error: "Chưa cập nhật được thông tin người dùng." });
  }
});

app.post("/api/admin/orders/:id/payments/vnpay/refund-confirmation", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || request.body?.refundProcessed !== true) {
    return response.status(400).json({ error: "Hãy xác nhận đã hoàn tiền VNPay trước khi cập nhật." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT phuong_thuc_thanh_toan AS paymentMethod, trang_thai_thanh_toan AS paymentStatus,
        trang_thai_don AS orderStatus
       FROM don_hang WHERE ma = ? FOR UPDATE`, [id],
    );
    const order = rows[0];
    if (!order || order.paymentMethod !== "vnpay" || order.orderStatus !== "cancelled") {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn VNPay đã hủy cần đối soát." });
    }
    if (order.paymentStatus === "refunded") {
      await connection.commit();
      return response.json({ ok: true, alreadyRefunded: true });
    }
    if (order.paymentStatus !== "paid") {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn chưa có khoản VNPay thành công cần hoàn." });
    }
    await connection.execute("UPDATE don_hang SET trang_thai_thanh_toan = 'refunded' WHERE ma = ?", [id]);
    await connection.commit();
    response.json({ ok: true });
  } catch {
    await connection.rollback();
    response.status(503).json({ error: "Chưa ghi nhận được kết quả hoàn tiền VNPay." });
  } finally {
    connection.release();
  }
});

app.patch("/api/admin/orders/:id", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  const orderStatus = request.body?.orderStatus;
  const paymentStatus = request.body?.paymentStatus;
  if (!Number.isSafeInteger(id) || id < 1
      || (orderStatus != null ? !allowedOrderStatuses.has(orderStatus) : paymentStatus !== "paid")) {
    return response.status(400).json({ error: "Trạng thái đơn không hợp lệ." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT o.trang_thai_don AS orderStatus, o.trang_thai_thanh_toan AS paymentStatus, o.phuong_thuc_thanh_toan AS paymentMethod,
        o.yeu_cau_huy_luc AS cancellationRequestedAt, o.khoa_don_blockchain AS blockchainKey,
        o.ma_bam_hoa_don AS blockchainDigest, cp.so_tien_wei AS amountWei, cp.trang_thai AS cryptoStatus,
        cp.ma_giao_dich_thanh_toan AS paymentTxHash
       FROM don_hang o LEFT JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma WHERE o.ma = ? FOR UPDATE`, [id],
    );
    const order = rows[0];
    if (!order) {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    }
    if (order.cancellationRequestedAt) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn đang có yêu cầu hủy. Hãy xử lý yêu cầu trước khi cập nhật trạng thái." });
    }
    if (orderStatus) {
      if (orderStatus === order.orderStatus) {
        await connection.commit();
        return response.json({ ok: true });
      }
      if (orderStatus === "cancelled" && order.orderStatus !== "cancelled"
          && order.paymentMethod === "vnpay" && ["unpaid", "failed"].includes(order.paymentStatus)) {
        const [activeAttempts] = await connection.execute(
          `SELECT ma AS id FROM lan_thanh_toan
           WHERE ma_don_hang = ? AND nha_cung_cap = 'vnpay' AND ma_phan_hoi IS NULL
             AND tao_luc >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)
           LIMIT 1 FOR UPDATE`, [id],
        );
        if (activeAttempts.length) {
          await connection.rollback();
          return response.status(409).json({ error: "Đơn còn phiên VNPay đang mở. Hãy chờ phiên hết hạn rồi hủy để tránh nhận tiền sau khi đơn đã hủy." });
        }
      }
      if (order.paymentMethod === "crypto" && orderStatus === "cancelled") {
        await connection.rollback();
        return response.status(409).json({ error: "Hãy duyệt yêu cầu hủy của khách để hệ thống xử lý khoản ETH." });
      }
      if (!orderTransitions[order.orderStatus]?.has(orderStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Không thể chuyển đơn theo thứ tự này. Hãy xử lý trạng thái hiện tại trước." });
      }
      if (["vnpay", "crypto"].includes(order.paymentMethod) && order.paymentStatus !== "paid"
          && ["confirmed", "packing", "shipped", "delivered"].includes(orderStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Chưa thể xử lý đơn thanh toán điện tử khi chưa xác nhận thanh toán." });
      }
      if (order.paymentMethod === "crypto" && ["shipped", "delivered"].includes(orderStatus)) {
        const shipping = orderStatus === "shipped";
        if (order.cryptoStatus !== (shipping ? "escrowed" : "shipped")) {
          throw Object.assign(new Error("Trạng thái hợp đồng chưa phù hợp để cập nhật đơn ETH."), { status: 409 });
        }
        const method = shipping ? "markShipped" : "releaseOrder";
        const txHash = await writeEscrowAction(order, method);
        const sql = shipping
          ? "UPDATE thanh_toan_eth SET trang_thai = 'shipped', ma_giao_dich_giao_hang = ? WHERE ma_don_hang = ?"
          : "UPDATE thanh_toan_eth SET trang_thai = 'released', ma_giao_dich_giai_ngan = ? WHERE ma_don_hang = ?";
        await connection.execute(sql, [txHash, id]);
      }
      if (orderStatus === "cancelled" && order.orderStatus !== "cancelled") {
        if (order.paymentStatus === "paid") {
          await connection.rollback();
          return response.status(409).json({ error: "Đơn đã thanh toán. Hãy xử lý hoàn tiền trước khi hủy." });
        }
        if (["shipped", "delivered"].includes(order.orderStatus)) {
          await connection.rollback();
          return response.status(409).json({ error: "Đơn đã giao cho vận chuyển nên không thể hủy ở đây." });
        }
        const [items] = await connection.execute(
          "SELECT ma_san_pham AS productId, so_luong AS quantity FROM chi_tiet_don_hang WHERE ma_don_hang = ?", [id],
        );
        for (const item of items) {
          if (item.productId != null) await connection.execute("UPDATE san_pham SET ton_kho = ton_kho + ? WHERE ma = ?", [item.quantity, item.productId]);
        }
      }
      await connection.execute("UPDATE don_hang SET trang_thai_don = ? WHERE ma = ?", [orderStatus, id]);
      await enqueueOrderProof(connection, id, orderStatus);
    } else {
      if (order.paymentMethod !== "cod") {
        await connection.rollback();
        return response.status(409).json({ error: "Chỉ admin xác nhận khoản thu COD tại đây; VNPay cập nhật tự động." });
      }
      if (order.orderStatus !== "delivered") {
        await connection.rollback();
        return response.status(409).json({ error: "Chỉ xác nhận đã thu COD sau khi đơn được giao." });
      }
      await connection.execute("UPDATE don_hang SET trang_thai_thanh_toan = 'paid' WHERE ma = ?", [id]);
    }
    await connection.commit();
    response.json({ ok: true });
  } catch (error) {
    await connection.rollback();
    response.status(error.status ?? 503).json({ error: error.status ? error.message : "Chưa cập nhật được đơn hàng." });
  } finally {
    connection.release();
  }
});

async function writeEscrowAction(order, method) {
  try { return await recordEscrowAction(order, method); }
  catch (error) {
    const message = /[À-ỹ]/u.test(error.message)
      ? error.message : "Chưa xử lý được giao dịch ETH. Kiểm tra kết nối blockchain rồi thử lại.";
    throw Object.assign(new Error(message), { status: 503 });
  }
}

app.post("/api/admin/orders/:id/cancellation-request", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  const action = request.body?.action;
  if (!Number.isSafeInteger(id) || id < 1 || !["approve", "decline"].includes(action)) {
    return response.status(400).json({ error: "Yêu cầu xử lý hủy đơn không hợp lệ." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT o.trang_thai_don AS orderStatus, o.trang_thai_thanh_toan AS paymentStatus,
        o.phuong_thuc_thanh_toan AS paymentMethod, o.yeu_cau_huy_luc AS cancellationRequestedAt,
        o.khoa_don_blockchain AS blockchainKey, o.ma_bam_hoa_don AS blockchainDigest,
        cp.so_tien_wei AS amountWei, cp.dia_chi_vi_khach AS buyerAddress, cp.ma_giao_dich_thanh_toan AS paymentTxHash,
        cp.trang_thai AS cryptoStatus
       FROM don_hang o LEFT JOIN thanh_toan_eth cp ON cp.ma_don_hang = o.ma
       WHERE o.ma = ? FOR UPDATE`, [id],
    );
    const order = rows[0];
    if (!order) {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    }
    if (!order.cancellationRequestedAt) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn hàng không còn yêu cầu hủy đang chờ xử lý." });
    }
    if (!["pending", "confirmed", "packing"].includes(order.orderStatus)) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn hàng đã chuyển sang giao hàng nên không thể xử lý hủy." });
    }
    if (action === "decline") {
      if (["refunded", "cancelled"].includes(order.cryptoStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Đã xử lý giao dịch ETH để hủy đơn. Hãy hoàn tất duyệt hủy." });
      }
      if (order.paymentMethod === "crypto" && !await canDeclineEscrowCancellation(order)) {
        await connection.rollback();
        return response.status(409).json({ error: "Hợp đồng đã xử lý hủy. Hãy duyệt hủy để cập nhật đơn." });
      }
      await connection.execute("UPDATE don_hang SET yeu_cau_huy_luc = NULL WHERE ma = ?", [id]);
    } else {
      if (order.paymentMethod === "vnpay" && ["unpaid", "failed"].includes(order.paymentStatus)) {
        const [activeAttempts] = await connection.execute(
          `SELECT ma AS id FROM lan_thanh_toan
           WHERE ma_don_hang = ? AND nha_cung_cap = 'vnpay' AND ma_phan_hoi IS NULL
             AND tao_luc >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)
           LIMIT 1 FOR UPDATE`, [id],
        );
        if (activeAttempts.length) {
          await connection.rollback();
          return response.status(409).json({ error: "Đơn còn phiên VNPay đang mở. Hãy chờ phiên hết hạn rồi duyệt hủy để tránh nhận tiền sau khi hủy đơn." });
        }
      }
      if (order.paymentMethod === "crypto") {
        if (order.paymentStatus === "paid" && order.cryptoStatus === "escrowed") {
          const txHash = await writeEscrowAction(order, "refundOrder");
          await connection.execute("UPDATE thanh_toan_eth SET trang_thai = 'refunded', ma_giao_dich_hoan_tien = ? WHERE ma_don_hang = ?", [txHash, id]);
        } else if (order.paymentStatus === "unpaid" && order.cryptoStatus === "unpaid") {
          const txHash = await writeEscrowAction(order, "cancelUnpaidOrder");
          await connection.execute("UPDATE thanh_toan_eth SET trang_thai = 'cancelled', ma_giao_dich_huy = ? WHERE ma_don_hang = ?", [txHash, id]);
        } else if (!["refunded", "cancelled"].includes(order.cryptoStatus)) {
          throw Object.assign(new Error("Trạng thái ETH chưa phù hợp để hủy đơn."), { status: 409 });
        }
      }
      if (order.paymentStatus === "paid" && order.paymentMethod !== "crypto" && request.body?.refundConfirmed !== true) {
        await connection.rollback();
        return response.status(409).json({ error: "Hãy xác nhận đã xử lý hoàn tiền trước khi duyệt hủy đơn đã thanh toán." });
      }
      const [items] = await connection.execute(
        "SELECT ma_san_pham AS productId, so_luong AS quantity FROM chi_tiet_don_hang WHERE ma_don_hang = ?", [id],
      );
      for (const item of items) {
        if (item.productId != null) {
          await connection.execute("UPDATE san_pham SET ton_kho = ton_kho + ? WHERE ma = ?", [item.quantity, item.productId]);
        }
      }
      await connection.execute(
        `UPDATE don_hang SET trang_thai_don = 'cancelled',
          trang_thai_thanh_toan = CASE WHEN trang_thai_thanh_toan = 'paid' THEN 'refunded' ELSE trang_thai_thanh_toan END,
          yeu_cau_huy_luc = NULL WHERE ma = ?`, [id],
      );
      await enqueueOrderProof(connection, id, "cancelled");
    }
    await connection.commit();
    response.json({ ok: true });
  } catch (error) {
    await connection.rollback();
    response.status(error.status ?? 503).json({ error: error.status ? error.message : "Chưa xử lý được yêu cầu hủy đơn." });
  } finally {
    connection.release();
  }
});

app.get("/api/admin/categories", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [categories] = await pool.execute("SELECT ma AS id, ten AS name, ten_duong_dan AS slug, mo_ta AS description FROM danh_muc ORDER BY ten");
    response.json({ categories });
  } catch {
    response.status(503).json({ error: "Chưa đọc được danh mục." });
  }
});

function categoryInput(body) {
  const name = cleanText(body?.name, 100);
  const description = cleanText(body?.description, 500);
  const slug = productSlug(name).slice(0, 119);
  if (!name || !slug) return { error: "Nhập tên danh mục hợp lệ." };
  return { name, slug, description };
}

app.post("/api/admin/categories", requireUser, requireAdmin, async (request, response) => {
  const data = categoryInput(request.body);
  if (data.error) return response.status(400).json({ error: data.error });
  try {
    const [result] = await pool.execute(
      "INSERT INTO danh_muc (ten, ten_duong_dan, mo_ta) VALUES (?, ?, ?)",
      [data.name, data.slug, data.description || null],
    );
    response.status(201).json({ id: result.insertId });
  } catch (error) {
    response.status(error.code === "ER_DUP_ENTRY" ? 409 : 503).json({
      error: error.code === "ER_DUP_ENTRY" ? "Tên hoặc đường dẫn danh mục đã tồn tại." : "Chưa lưu được danh mục.",
    });
  }
});

app.patch("/api/admin/categories/:id", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Mã danh mục không hợp lệ." });
  const data = categoryInput(request.body);
  if (data.error) return response.status(400).json({ error: data.error });
  try {
    const [existing] = await pool.execute("SELECT ma AS id FROM danh_muc WHERE ma = ? LIMIT 1", [id]);
    if (!existing.length) return response.status(404).json({ error: "Không tìm thấy danh mục." });
    await pool.execute(
      "UPDATE danh_muc SET ten = ?, ten_duong_dan = ?, mo_ta = ? WHERE ma = ?",
      [data.name, data.slug, data.description || null, id],
    );
    response.json({ ok: true });
  } catch (error) {
    response.status(error.code === "ER_DUP_ENTRY" ? 409 : 503).json({
      error: error.code === "ER_DUP_ENTRY" ? "Tên hoặc đường dẫn danh mục đã tồn tại." : "Chưa cập nhật được danh mục.",
    });
  }
});

app.get("/api/admin/products", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [products] = await pool.execute(
      "SELECT ma AS id, ten AS name, ten_duong_dan AS slug, ma_danh_muc AS categoryId, gia_vnd AS priceVnd, gia_niem_yet_vnd AS compareAtVnd, ton_kho AS stock, mo_ta_ngan AS shortDescription, duong_dan_anh AS imageUrl, thong_so AS specifications, dang_hoat_dong AS isActive FROM san_pham ORDER BY ma DESC",
    );
    response.json({ products });
  } catch {
    response.status(503).json({ error: "Chưa đọc được sản phẩm từ MySQL." });
  }
});

app.post("/api/admin/product-images", requireUser, requireAdmin,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }),
  async (request, response) => {
    const image = request.body;
    if (!Buffer.isBuffer(image) || image.length === 0) {
      return response.status(400).json({ error: "Vui lòng chọn một ảnh JPG, PNG hoặc WebP." });
    }

    let extension;
    let mimeType;
    if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
      extension = "jpg";
      mimeType = "image/jpeg";
    } else if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      extension = "png";
      mimeType = "image/png";
    } else if (image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP") {
      extension = "webp";
      mimeType = "image/webp";
    } else {
      return response.status(415).json({ error: "Tệp đã chọn không phải ảnh JPG, PNG hoặc WebP hợp lệ." });
    }

    if (request.headers["content-type"] !== mimeType) {
      return response.status(415).json({ error: "Định dạng ảnh không khớp với nội dung tệp." });
    }

    const filename = `${randomUUID()}.${extension}`;
    const uploadsDirectory = new URL("../public/uploads/products/", import.meta.url);
    try {
      await mkdir(uploadsDirectory, { recursive: true });
      await writeFile(new URL(filename, uploadsDirectory), image, { flag: "wx", mode: 0o644 });
      response.status(201).json({ imageUrl: `/uploads/products/${filename}` });
    } catch {
      response.status(500).json({ error: "Chưa lưu được ảnh sản phẩm vào máy chủ." });
    }
  },
);

function productInput(body) {
  const name = cleanText(body?.name, 180);
  const categoryId = Number(body?.categoryId);
  const priceVnd = Number(body?.priceVnd);
  const compareAtVnd = body?.compareAtVnd === "" || body?.compareAtVnd == null ? null : Number(body.compareAtVnd);
  const shortDescription = cleanText(body?.shortDescription, 500);
  const imageUrl = cleanText(body?.imageUrl, 500) || "/assets/watch-placeholder.svg";
  const validImageUrl = /^\/(?:assets|uploads\/products)\/[a-z\d._/-]+$/i.test(imageUrl)
    && !imageUrl.includes("..");
  const specificationsText = typeof body?.specifications === "string" ? body.specifications : JSON.stringify(body?.specifications ?? {});
  let specifications;
  try { specifications = JSON.parse(specificationsText); } catch { return { error: "Thông số phải là JSON hợp lệ." }; }
  if (!name || !Number.isSafeInteger(categoryId) || categoryId < 1 || !Number.isSafeInteger(priceVnd) || priceVnd < 1
      || (compareAtVnd != null && (!Number.isSafeInteger(compareAtVnd) || compareAtVnd < priceVnd))
      || !validImageUrl || !specifications || Array.isArray(specifications) || typeof specifications !== "object") {
    return { error: "Kiểm tra tên, danh mục, giá, ảnh đã chọn và thông số sản phẩm." };
  }
  return { name, slug: productSlug(name), categoryId, priceVnd, compareAtVnd, shortDescription, imageUrl, specifications: JSON.stringify(specifications) };
}

app.post("/api/admin/products", requireUser, requireAdmin, async (request, response) => {
  const data = productInput(request.body);
  if (data.error) return response.status(400).json({ error: data.error });
  try {
    const [result] = await pool.execute(
      `INSERT INTO san_pham (ma_danh_muc, ten, ten_duong_dan, mo_ta_ngan, thong_so, gia_vnd, gia_niem_yet_vnd, duong_dan_anh)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.categoryId, data.name, data.slug, data.shortDescription, data.specifications, data.priceVnd, data.compareAtVnd, data.imageUrl],
    );
    response.status(201).json({ id: result.insertId });
  } catch (error) {
    response.status(error.code === "ER_DUP_ENTRY" ? 409 : 400).json({ error: error.code === "ER_DUP_ENTRY" ? "Tên sản phẩm đã tồn tại." : "Chưa lưu được sản phẩm; kiểm tra danh mục." });
  }
});

app.patch("/api/admin/products/:id/stock", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  const stock = Number(request.body?.stock);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Mã sản phẩm không hợp lệ." });
  if (!Number.isSafeInteger(stock) || stock < 0 || stock > 4294967295) {
    return response.status(400).json({ error: "Số lượng tồn kho phải là số nguyên từ 0 đến 4.294.967.295." });
  }
  try {
    const [existing] = await pool.execute("SELECT ma FROM san_pham WHERE ma = ? LIMIT 1", [id]);
    if (!existing.length) return response.status(404).json({ error: "Không tìm thấy sản phẩm." });
    await pool.execute("UPDATE san_pham SET ton_kho = ? WHERE ma = ?", [stock, id]);
    response.json({ ok: true, stock });
  } catch {
    response.status(503).json({ error: "Chưa cập nhật được số lượng tồn kho." });
  }
});

app.patch("/api/admin/products/:id", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Mã sản phẩm không hợp lệ." });
  if (typeof request.body?.isActive === "boolean") {
    try {
      const [result] = await pool.execute("UPDATE san_pham SET dang_hoat_dong = ? WHERE ma = ?", [request.body.isActive, id]);
      return result.affectedRows ? response.json({ ok: true }) : response.status(404).json({ error: "Không tìm thấy sản phẩm." });
    } catch {
      return response.status(503).json({ error: "Chưa cập nhật được sản phẩm." });
    }
  }
  const data = productInput(request.body);
  if (data.error) return response.status(400).json({ error: data.error });
  try {
    const [result] = await pool.execute(
      `UPDATE san_pham SET ma_danh_muc = ?, ten = ?, ten_duong_dan = ?, mo_ta_ngan = ?, thong_so = ?,
       gia_vnd = ?, gia_niem_yet_vnd = ?, duong_dan_anh = ? WHERE ma = ?`,
      [data.categoryId, data.name, data.slug, data.shortDescription, data.specifications, data.priceVnd, data.compareAtVnd, data.imageUrl, id],
    );
    response.json({ ok: Boolean(result.affectedRows) });
  } catch (error) {
    response.status(error.code === "ER_DUP_ENTRY" ? 409 : 400).json({ error: error.code === "ER_DUP_ENTRY" ? "Tên sản phẩm đã tồn tại." : "Chưa cập nhật được sản phẩm." });
  }
});

app.use("/api", (_request, response) => response.status(404).json({ error: "API không tồn tại." }));
app.use("/vendor/ethers", express.static(fileURLToPath(new URL("../node_modules/ethers/dist/", import.meta.url)), { maxAge: "1d" }));
app.use("/vendor/sweetalert2", express.static(fileURLToPath(new URL("../node_modules/sweetalert2/dist/", import.meta.url)), { maxAge: "1d" }));
app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));
app.use((_request, response) => response.status(404).sendFile(fileURLToPath(new URL("../public/404.html", import.meta.url))));
app.use((error, _request, response, _next) => {
  if (error.type === "entity.too.large") return response.status(413).json({ error: "Ảnh sản phẩm không được vượt quá 5 MB." });
  console.error("Request failed:", error.message);
  if (!response.headersSent) response.status(500).json({ error: "Có lỗi nội bộ. Hãy thử lại." });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Xiaomi Watch Store đang chạy tại http://127.0.0.1:${port}`);
  startBlockchainAutomation();
});
