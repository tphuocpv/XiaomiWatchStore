import "dotenv/config";
import bcrypt from "bcryptjs";
import express from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import helmet from "helmet";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Interface, JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { chainId, rpcUrl } from "../local-network.js";
import { pool } from "./db.js";
import { CryptoTransactionError, cryptoExchangeRate, formatCryptoWei, loadCryptoDeployment, quoteCryptoWei, signCryptoQuote, verifyEscrowTransaction } from "./crypto-payments.js";
import { createVnpayUrl, hasVnpayCredentials, verifyVnpayQuery } from "./vnpay.js";

const app = express();
const port = Number(process.env.PORT ?? 3000);
const sessionSecret = process.env.SESSION_SECRET;
const deploymentFile = new URL("../public/deployment.json", import.meta.url);
const orderStatusCode = { pending: 1, confirmed: 2, packing: 3, shipped: 4, delivered: 5, cancelled: 6 };
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
    `SELECT o.id, o.order_code AS orderCode, o.total_vnd AS totalVnd,
        o.payment_method AS paymentMethod, o.order_status AS orderStatus
     FROM payment_attempts pa JOIN orders o ON o.id = pa.order_id
     WHERE pa.transaction_ref = ? AND pa.provider = 'vnpay' LIMIT 1`,
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
      "SELECT payment_status AS paymentStatus, order_status AS orderStatus FROM orders WHERE id = ? FOR UPDATE", [order.id],
    );
    const locked = lockedRows[0];
    const status = locked?.paymentStatus;
    if (status === "paid") {
      if (success) {
        await connection.execute(
          "UPDATE payment_attempts SET response_code = '00', secure_hash_valid = TRUE WHERE transaction_ref = ?",
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
        "UPDATE orders SET payment_status = 'paid', order_status = CASE WHEN order_status = 'cancelled' THEN 'cancelled' ELSE 'confirmed' END WHERE id = ?", [order.id],
      );
    } else {
      await connection.execute("UPDATE orders SET payment_status = 'failed' WHERE id = ?", [order.id]);
    }
    await connection.execute(
      "UPDATE payment_attempts SET response_code = ?, secure_hash_valid = TRUE WHERE transaction_ref = ?",
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
    const [rows] = await pool.execute("SELECT id, name, slug, description FROM categories ORDER BY name");
    response.json({ categories: rows });
  } catch {
    response.status(503).json({ error: "MySQL chưa sẵn sàng. Hãy khởi động MySQL và nhập schema." });
  }
});

app.get("/api/products", async (request, response) => {
  try {
    const search = cleanText(request.query.search, 100);
    const category = cleanText(request.query.category, 120);
    const conditions = ["p.is_active = TRUE"];
    const values = [];
    if (search) {
      conditions.push("(p.name LIKE ? OR p.short_description LIKE ?)");
      values.push(`%${search}%`, `%${search}%`);
    }
    if (category) {
      conditions.push("c.slug = ?");
      values.push(category);
    }
    const [rows] = await pool.execute(
      `SELECT p.id, p.name, p.slug, p.short_description AS shortDescription,
              p.specifications, p.price_vnd AS priceVnd,
              p.compare_at_vnd AS compareAtVnd, p.stock,
              p.image_url AS imageUrl, c.name AS categoryName, c.slug AS categorySlug
       FROM products p JOIN categories c ON c.id = p.category_id
       WHERE ${conditions.join(" AND ")} ORDER BY p.id`, values,
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
      "INSERT INTO users (full_name, phone, email, username, address, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
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
      "SELECT id, full_name, phone, email, address, username, password_hash, role FROM users WHERE username = ? OR email = ? LIMIT 1",
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
        "SELECT id, name, price_vnd AS priceVnd, stock FROM products WHERE id = ? AND is_active = TRUE FOR UPDATE", [productId],
      );
      const product = rows[0];
      if (!product) throw Object.assign(new Error("Một sản phẩm không còn được bán."), { status: 409 });
      if (Number(product.stock) < quantity) throw Object.assign(new Error(`Mẫu ${product.name} không đủ tồn kho.`), { status: 409 });
      const unitPrice = Number(product.priceVnd);
      subtotal += unitPrice * quantity;
      items.push({ productId: product.id, productName: product.name, unitPrice, quantity });
      await connection.execute("UPDATE products SET stock = stock - ? WHERE id = ?", [quantity, product.id]);
    }
    const orderCode = makeOrderCode();
    const transactionRef = paymentMethod === "vnpay" ? makeVnpayReference(orderCode) : null;
    const cryptoAmountWei = paymentMethod === "crypto" ? quoteCryptoWei(subtotal) : null;
    const createdAt = new Date();
    if (paymentMethod === "vnpay" && subtotal < 5000) {
      throw Object.assign(new Error("VNPay sandbox yêu cầu thanh toán tối thiểu 5.000 ₫."), { status: 400 });
    }
    const orderKey = keccak256(toUtf8Bytes(orderCode));
    const digestPayload = JSON.stringify({
      orderCode, totalVnd: subtotal, paymentMethod,
      items: items.map(({ productId, productName, unitPrice, quantity }) => ({ productId, productName, unitPrice, quantity })),
      createdAt: createdAt.toISOString(),
    });
    const orderDigest = keccak256(toUtf8Bytes(digestPayload));
    const [insert] = await connection.execute(
      `INSERT INTO orders
        (order_code, user_id, subtotal_vnd, shipping_fee_vnd, total_vnd, payment_method,
         order_status, shipping_name, shipping_phone, shipping_address, customer_note,
         blockchain_key, blockchain_digest, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [orderCode, request.session.user.id, subtotal, subtotal, paymentMethod,
        shippingName, shippingPhone, shippingAddress, note || null, orderKey, orderDigest, createdAt],
    );
    for (const item of items) {
      await connection.execute(
        "INSERT INTO order_items (order_id, product_id, product_name, unit_price_vnd, quantity) VALUES (?, ?, ?, ?, ?)",
        [insert.insertId, item.productId, item.productName, item.unitPrice, item.quantity],
      );
    }
    if (paymentMethod === "crypto") {
      await connection.execute(
        "INSERT INTO crypto_payments (order_id, chain_id, amount_wei) VALUES (?, ?, ?)",
        [insert.insertId, chainId, cryptoAmountWei],
      );
    }
    let paymentUrl = null;
    if (paymentMethod === "vnpay") {
      await connection.execute(
        "INSERT INTO payment_attempts (order_id, provider, transaction_ref) VALUES (?, 'vnpay', ?)",
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
      `SELECT order_code AS orderCode, total_vnd AS totalVnd, payment_method AS paymentMethod,
        payment_status AS paymentStatus, order_status AS orderStatus,
        cancellation_requested_at AS cancellationRequestedAt
       FROM orders WHERE id = ? AND user_id = ? FOR UPDATE`, [id, request.session.user.id],
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
      `SELECT id FROM payment_attempts
       WHERE order_id = ? AND provider = 'vnpay' AND response_code IS NULL
         AND created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)
       LIMIT 1 FOR UPDATE`, [id],
    );
    if (activeAttempts.length) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn vẫn còn phiên VNPay đang mở. Hãy hoàn tất hoặc chờ tối đa 15 phút rồi thanh toán lại." });
    }
    const transactionRef = makeVnpayReference(order.orderCode);
    const paymentUrl = createVnpayUrl({ orderCode: transactionRef, amountVnd: order.totalVnd, clientIp: request.ip || "127.0.0.1" });
    await connection.execute(
      "INSERT INTO payment_attempts (order_id, provider, transaction_ref) VALUES (?, 'vnpay', ?)", [id, transactionRef],
    );
    if (order.paymentStatus === "failed") {
      await connection.execute("UPDATE orders SET payment_status = 'unpaid' WHERE id = ?", [id]);
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
      `SELECT o.order_code AS orderCode, o.payment_method AS paymentMethod,
        o.payment_status AS paymentStatus, o.order_status AS orderStatus,
        o.cancellation_requested_at AS cancellationRequestedAt, o.blockchain_key AS blockchainKey,
        o.blockchain_digest AS blockchainDigest, cp.amount_wei AS amountWei, cp.status AS cryptoStatus
       FROM orders o JOIN crypto_payments cp ON cp.order_id = o.id
       WHERE o.id = ? AND o.user_id = ? LIMIT 1`, [id, request.session.user.id],
    );
    const order = rows[0];
    if (!order) return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    if (order.paymentMethod !== "crypto") return response.status(409).json({ error: "Đơn hàng này không sử dụng ETH thử nghiệm." });
    if (!['unpaid', 'failed'].includes(order.paymentStatus) || order.cryptoStatus !== "unpaid"
        || ["cancelled", "shipped", "delivered"].includes(order.orderStatus) || order.cancellationRequestedAt) {
      return response.status(409).json({ error: "Đơn hàng hiện không thể thanh toán lại." });
    }
    const deployment = await loadCryptoDeployment(deploymentFile);
    provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    if (Number(await provider.send("eth_chainId", [])) !== chainId
        || await provider.getCode(deployment.escrow.address) === "0x") {
      return response.status(503).json({ error: "Không tìm thấy hợp đồng thanh toán trên LabChain Local. Hãy khởi động mạng và chạy deploy:local." });
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
  } catch (error) {
    response.status(503).json({ error: error.message || "Chưa tạo được yêu cầu thanh toán ETH. Kiểm tra mạng local." });
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
      `SELECT o.order_code AS orderCode, o.payment_status AS paymentStatus, o.order_status AS orderStatus,
        o.blockchain_key AS blockchainKey, o.blockchain_digest AS blockchainDigest,
        cp.amount_wei AS amountWei, cp.payment_tx_hash AS paymentTxHash, cp.status AS cryptoStatus
       FROM orders o JOIN crypto_payments cp ON cp.order_id = o.id
       WHERE o.id = ? AND o.user_id = ? AND o.payment_method = 'crypto' LIMIT 1`, [id, request.session.user.id],
    );
    const order = rows[0];
    if (!order) return response.status(404).json({ error: "Không tìm thấy đơn ETH thử nghiệm." });
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
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [lockedRows] = await connection.execute(
        `SELECT o.payment_status AS paymentStatus, o.order_status AS orderStatus,
          cp.status AS cryptoStatus, cp.payment_tx_hash AS paymentTxHash
         FROM orders o JOIN crypto_payments cp ON cp.order_id = o.id
         WHERE o.id = ? AND o.user_id = ? FOR UPDATE`, [id, request.session.user.id],
      );
      const locked = lockedRows[0];
      if (!locked) {
        await connection.rollback();
        return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
      }
      if (locked.paymentStatus === "paid" && locked.paymentTxHash?.toLowerCase() === txHash.toLowerCase()) {
        await connection.commit();
        return response.json({ ok: true, txHash, alreadyConfirmed: true });
      }
      if (locked.paymentStatus !== "unpaid" || locked.cryptoStatus !== "unpaid"
          || ["cancelled", "shipped", "delivered"].includes(locked.orderStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Đơn hàng đã thay đổi trạng thái trước khi xác nhận thanh toán." });
      }
      await connection.execute(
        "UPDATE orders SET payment_status = 'paid', order_status = CASE WHEN order_status = 'pending' THEN 'confirmed' ELSE order_status END WHERE id = ?",
        [id],
      );
      await connection.execute(
        "UPDATE crypto_payments SET status = 'escrowed', buyer_address = ?, payment_tx_hash = ? WHERE order_id = ?",
        [payment.buyerAddress, txHash, id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    response.json({ ok: true, txHash });
  } catch (error) {
    const status = error instanceof CryptoTransactionError ? 400 : 503;
    response.status(status).json({ error: error.message || "Chưa xác minh được thanh toán trên mạng local." });
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
      `SELECT order_status AS orderStatus, cancellation_requested_at AS cancellationRequestedAt
       FROM orders WHERE id = ? AND user_id = ? FOR UPDATE`, [id, request.session.user.id],
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
      await connection.execute("UPDATE orders SET cancellation_requested_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
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
      `SELECT o.id, o.order_code AS orderCode, o.total_vnd AS totalVnd, o.payment_method AS paymentMethod,
        o.payment_status AS paymentStatus, o.order_status AS orderStatus,
        o.cancellation_requested_at AS cancellationRequestedAt, o.created_at AS createdAt,
        (SELECT MAX(DATE_ADD(pa.created_at, INTERVAL 15 MINUTE))
         FROM payment_attempts pa
         WHERE pa.order_id = o.id AND pa.provider = 'vnpay' AND pa.response_code IS NULL) AS vnpayPendingUntil,
        cp.amount_wei AS cryptoAmountWei, cp.status AS cryptoStatus,
        cp.buyer_address AS cryptoBuyerAddress, cp.payment_tx_hash AS cryptoPaymentTxHash,
        cp.ship_tx_hash AS cryptoShipTxHash, cp.release_tx_hash AS cryptoReleaseTxHash,
        cp.refund_tx_hash AS cryptoRefundTxHash
       FROM orders o LEFT JOIN crypto_payments cp ON cp.order_id = o.id
       WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50`, [request.session.user.id],
    );
    response.json({ orders: await attachOrderItems(orders) });
  } catch {
    response.status(503).json({ error: "Chưa đọc được lịch sử đơn hàng." });
  }
});

async function attachOrderItems(orders) {
  if (!orders.length) return [];
  const ids = orders.map((order) => order.id);
  const placeholders = ids.map(() => "?").join(", ");
  const [items] = await pool.execute(
    `SELECT order_id AS orderId, product_name AS productName, unit_price_vnd AS unitPriceVnd, quantity
     FROM order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, id`, ids,
  );
  const byOrder = new Map();
  for (const item of items) {
    const key = String(item.orderId);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(item);
  }
  return orders.map((order) => ({ ...order, items: byOrder.get(String(order.id)) ?? [] }));
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
      `SELECT o.id, o.order_code AS orderCode, o.total_vnd AS totalVnd, o.payment_method AS paymentMethod,
        o.payment_status AS paymentStatus, o.order_status AS orderStatus, o.shipping_name AS shippingName,
        o.shipping_phone AS shippingPhone, o.shipping_address AS shippingAddress,
        o.cancellation_requested_at AS cancellationRequestedAt, o.blockchain_key AS blockchainKey,
        o.blockchain_digest AS blockchainDigest, o.blockchain_tx_hash AS blockchainTxHash,
        o.blockchain_status AS blockchainStatus, o.created_at AS createdAt,
        (SELECT MAX(DATE_ADD(pa.created_at, INTERVAL 15 MINUTE))
         FROM payment_attempts pa
         WHERE pa.order_id = o.id AND pa.provider = 'vnpay' AND pa.response_code IS NULL) AS vnpayPendingUntil,
        cp.amount_wei AS cryptoAmountWei, cp.status AS cryptoStatus,
        cp.buyer_address AS cryptoBuyerAddress, cp.payment_tx_hash AS cryptoPaymentTxHash,
        cp.ship_tx_hash AS cryptoShipTxHash, cp.release_tx_hash AS cryptoReleaseTxHash,
        cp.refund_tx_hash AS cryptoRefundTxHash,
        cp.cancel_tx_hash AS cryptoCancelTxHash
       FROM orders o LEFT JOIN crypto_payments cp ON cp.order_id = o.id
       ORDER BY o.created_at DESC LIMIT 100`,
    );
    response.json({ orders: await attachOrderItems(orders) });
  } catch {
    response.status(503).json({ error: "Chưa đọc được đơn hàng từ MySQL." });
  }
});

app.get("/api/admin/users", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [users] = await pool.execute(
      `SELECT u.id, u.full_name AS fullName, u.username, u.phone, u.email, u.address,
        u.created_at AS createdAt, COUNT(o.id) AS orderCount
       FROM users u LEFT JOIN orders o ON o.user_id = u.id
       WHERE u.role = 'customer'
       GROUP BY u.id, u.full_name, u.username, u.phone, u.email, u.address, u.created_at
       ORDER BY u.created_at DESC LIMIT 500`,
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
      "UPDATE users SET full_name = ?, phone = ?, email = ?, address = ? WHERE id = ? AND role = 'customer'",
      [fullName, phone, email, address || null, id],
    );
    if (result.affectedRows) return response.json({ ok: true });
    const [rows] = await pool.execute("SELECT id FROM users WHERE id = ? AND role = 'customer' LIMIT 1", [id]);
    if (rows.length) return response.json({ ok: true });
    response.status(404).json({ error: "Không tìm thấy người dùng." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return response.status(409).json({ error: "Email hoặc số điện thoại đã được tài khoản khác sử dụng." });
    response.status(503).json({ error: "Chưa cập nhật được thông tin người dùng." });
  }
});

app.post("/api/admin/orders/:id/payments/crypto/action", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  const action = request.body?.action;
  const txHash = cleanText(request.body?.txHash, 66);
  const definitions = {
    "mark-shipped": { method: "markShipped", targetStatus: "shipped", expectedStatus: "packing", expectedCrypto: "escrowed" },
    release: { method: "releaseOrder", targetStatus: "released", expectedStatus: "shipped", expectedCrypto: "shipped" },
    refund: { method: "refundOrder", targetStatus: "refunded", expectedCrypto: "escrowed" },
    "cancel-unpaid": { method: "cancelUnpaidOrder", targetStatus: "cancelled", expectedCrypto: "unpaid" },
  };
  const definition = definitions[action];
  if (!Number.isSafeInteger(id) || id < 1 || !definition || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return response.status(400).json({ error: "Thông tin giao dịch thanh toán ETH chưa hợp lệ." });
  }
  const connection = await pool.getConnection();
  let provider;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT o.order_code AS orderCode, o.payment_method AS paymentMethod,
        o.payment_status AS paymentStatus, o.order_status AS orderStatus,
        o.cancellation_requested_at AS cancellationRequestedAt,
        o.blockchain_key AS blockchainKey, o.blockchain_digest AS blockchainDigest,
        cp.amount_wei AS amountWei, cp.status AS cryptoStatus,
        cp.buyer_address AS buyerAddress, cp.payment_tx_hash AS paymentTxHash,
        cp.ship_tx_hash AS shipTxHash, cp.release_tx_hash AS releaseTxHash,
        cp.refund_tx_hash AS refundTxHash, cp.cancel_tx_hash AS cancelTxHash
       FROM orders o JOIN crypto_payments cp ON cp.order_id = o.id
       WHERE o.id = ? FOR UPDATE`, [id],
    );
    const order = rows[0];
    if (!order || order.paymentMethod !== "crypto") {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn thanh toán ETH thử nghiệm." });
    }
    const savedHash = {
      "mark-shipped": order.shipTxHash, release: order.releaseTxHash,
      refund: order.refundTxHash, "cancel-unpaid": order.cancelTxHash,
    }[action];
    if (savedHash?.toLowerCase() === txHash.toLowerCase()) {
      await connection.commit();
      return response.json({ ok: true, txHash, alreadyConfirmed: true });
    }
    if (action === "mark-shipped" && (order.orderStatus !== definition.expectedStatus
        || order.cryptoStatus !== definition.expectedCrypto || order.paymentStatus !== "paid")) {
      await connection.rollback();
      return response.status(409).json({ error: "Đơn phải đã đóng gói và có tiền trong escrow trước khi chuyển sang đang giao." });
    }
    if (action === "release" && (order.orderStatus !== definition.expectedStatus
        || order.cryptoStatus !== definition.expectedCrypto || order.paymentStatus !== "paid")) {
      await connection.rollback();
      return response.status(409).json({ error: "Chỉ giải ngân sau khi đơn đã chuyển sang đang giao." });
    }
    if (["refund", "cancel-unpaid"].includes(action)) {
      if (!order.cancellationRequestedAt || !["pending", "confirmed", "packing"].includes(order.orderStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Chỉ xử lý hủy đơn khi yêu cầu còn hiệu lực và đơn chưa chuyển sang giao hàng." });
      }
      if (order.cryptoStatus !== definition.expectedCrypto
          || (action === "refund" && order.paymentStatus !== "paid")
          || (action === "cancel-unpaid" && order.paymentStatus !== "unpaid")) {
        await connection.rollback();
        return response.status(409).json({ error: "Trạng thái thanh toán trên hệ thống không khớp với thao tác hoàn/hủy." });
      }
    }
    const deployment = await loadCryptoDeployment(deploymentFile);
    provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    await verifyEscrowTransaction({
      provider, deployment, txHash, order, methodName: definition.method,
      amountWei: order.amountWei,
    });
    if (action === "mark-shipped") {
      await connection.execute("UPDATE crypto_payments SET status = 'shipped', ship_tx_hash = ? WHERE order_id = ?", [txHash, id]);
      await connection.execute("UPDATE orders SET order_status = 'shipped' WHERE id = ?", [id]);
    } else if (action === "release") {
      await connection.execute("UPDATE crypto_payments SET status = 'released', release_tx_hash = ? WHERE order_id = ?", [txHash, id]);
      await connection.execute("UPDATE orders SET order_status = 'delivered' WHERE id = ?", [id]);
    } else if (action === "refund") {
      await connection.execute("UPDATE crypto_payments SET status = 'refunded', refund_tx_hash = ? WHERE order_id = ?", [txHash, id]);
      await connection.execute("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [id]);
    } else {
      await connection.execute("UPDATE crypto_payments SET status = 'cancelled', cancel_tx_hash = ? WHERE order_id = ?", [txHash, id]);
    }
    await connection.commit();
    response.json({ ok: true, txHash, cryptoStatus: definition.targetStatus });
  } catch (error) {
    await connection.rollback();
    const status = error instanceof CryptoTransactionError ? 400 : 503;
    response.status(status).json({ error: error.message || "Chưa xác minh được giao dịch trên blockchain." });
  } finally {
    provider?.destroy();
    connection.release();
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
      `SELECT payment_method AS paymentMethod, payment_status AS paymentStatus,
        order_status AS orderStatus
       FROM orders WHERE id = ? FOR UPDATE`, [id],
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
    await connection.execute("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [id]);
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
  if (!Number.isSafeInteger(id) || id < 1 || (!allowedOrderStatuses.has(orderStatus) && paymentStatus !== "paid")) {
    return response.status(400).json({ error: "Trạng thái đơn không hợp lệ." });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT o.order_status AS orderStatus, o.payment_status AS paymentStatus, o.payment_method AS paymentMethod,
        o.cancellation_requested_at AS cancellationRequestedAt
       FROM orders o WHERE o.id = ? FOR UPDATE`, [id],
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
      if (orderStatus === "cancelled" && order.orderStatus !== "cancelled"
          && order.paymentMethod === "vnpay" && order.paymentStatus === "unpaid") {
        const [activeAttempts] = await connection.execute(
          `SELECT id FROM payment_attempts
           WHERE order_id = ? AND provider = 'vnpay' AND response_code IS NULL
             AND created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)
           LIMIT 1 FOR UPDATE`, [id],
        );
        if (activeAttempts.length) {
          await connection.rollback();
          return response.status(409).json({ error: "Đơn còn phiên VNPay đang mở. Hãy chờ phiên hết hạn rồi hủy để tránh nhận tiền sau khi đơn đã hủy." });
        }
      }
      if (order.paymentMethod === "crypto" && ["shipped", "delivered", "cancelled"].includes(orderStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Đơn ETH cần xác nhận thao tác đang giao, giải ngân hoặc hủy bằng MetaMask." });
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
          "SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?", [id],
        );
        for (const item of items) {
          if (item.productId != null) await connection.execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.productId]);
        }
      }
      await connection.execute("UPDATE orders SET order_status = ? WHERE id = ?", [orderStatus, id]);
    } else {
      if (order.paymentMethod !== "cod") {
        await connection.rollback();
        return response.status(409).json({ error: "Chỉ admin xác nhận khoản thu COD tại đây; VNPay cập nhật tự động." });
      }
      if (order.orderStatus !== "delivered") {
        await connection.rollback();
        return response.status(409).json({ error: "Chỉ xác nhận đã thu COD sau khi đơn được giao." });
      }
      await connection.execute("UPDATE orders SET payment_status = 'paid' WHERE id = ?", [id]);
    }
    await connection.commit();
    response.json({ ok: true });
  } catch {
    await connection.rollback();
    response.status(503).json({ error: "Chưa cập nhật được đơn hàng." });
  } finally {
    connection.release();
  }
});

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
      `SELECT o.order_status AS orderStatus, o.payment_status AS paymentStatus,
        o.payment_method AS paymentMethod, o.cancellation_requested_at AS cancellationRequestedAt,
        cp.status AS cryptoStatus, cp.refund_tx_hash AS cryptoRefundTxHash,
        cp.cancel_tx_hash AS cryptoCancelTxHash
       FROM orders o LEFT JOIN crypto_payments cp ON cp.order_id = o.id
       WHERE o.id = ? FOR UPDATE`, [id],
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
      await connection.execute("UPDATE orders SET cancellation_requested_at = NULL WHERE id = ?", [id]);
    } else {
      if (order.paymentMethod === "vnpay" && order.paymentStatus === "unpaid") {
        const [activeAttempts] = await connection.execute(
          `SELECT id FROM payment_attempts
           WHERE order_id = ? AND provider = 'vnpay' AND response_code IS NULL
             AND created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)
           LIMIT 1 FOR UPDATE`, [id],
        );
        if (activeAttempts.length) {
          await connection.rollback();
          return response.status(409).json({ error: "Đơn còn phiên VNPay đang mở. Hãy chờ phiên hết hạn rồi duyệt hủy để tránh nhận tiền sau khi hủy đơn." });
        }
      }
      if (order.paymentMethod === "crypto" && order.paymentStatus === "paid"
          && (order.cryptoStatus !== "refunded" || !order.cryptoRefundTxHash)) {
        await connection.rollback();
        return response.status(409).json({ error: "Hãy xác nhận giao dịch hoàn ETH trên MetaMask trước khi duyệt hủy đơn." });
      }
      if (order.paymentMethod === "crypto" && order.paymentStatus === "unpaid"
          && (order.cryptoStatus !== "cancelled" || !order.cryptoCancelTxHash)) {
        await connection.rollback();
        return response.status(409).json({ error: "Hãy xác nhận giao dịch khóa đơn chưa thanh toán trên MetaMask trước khi duyệt hủy." });
      }
      if (order.paymentStatus === "paid" && order.paymentMethod !== "crypto" && request.body?.refundConfirmed !== true) {
        await connection.rollback();
        return response.status(409).json({ error: "Hãy xác nhận đã xử lý hoàn tiền trước khi duyệt hủy đơn đã thanh toán." });
      }
      const [items] = await connection.execute(
        "SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?", [id],
      );
      for (const item of items) {
        if (item.productId != null) {
          await connection.execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.productId]);
        }
      }
      await connection.execute(
        `UPDATE orders SET order_status = 'cancelled',
          payment_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE payment_status END,
          cancellation_requested_at = NULL WHERE id = ?`, [id],
      );
    }
    await connection.commit();
    response.json({ ok: true });
  } catch {
    await connection.rollback();
    response.status(503).json({ error: "Chưa xử lý được yêu cầu hủy đơn." });
  } finally {
    connection.release();
  }
});

app.get("/api/admin/categories", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [categories] = await pool.execute("SELECT id, name, slug, description FROM categories ORDER BY name");
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
      "INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)",
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
    const [existing] = await pool.execute("SELECT id FROM categories WHERE id = ? LIMIT 1", [id]);
    if (!existing.length) return response.status(404).json({ error: "Không tìm thấy danh mục." });
    await pool.execute(
      "UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?",
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
      "SELECT id, name, slug, category_id AS categoryId, price_vnd AS priceVnd, stock, short_description AS shortDescription, image_url AS imageUrl, specifications, is_active AS isActive FROM products ORDER BY id DESC",
    );
    response.json({ products });
  } catch {
    response.status(503).json({ error: "Chưa đọc được sản phẩm từ MySQL." });
  }
});

function productInput(body) {
  const name = cleanText(body?.name, 180);
  const categoryId = Number(body?.categoryId);
  const priceVnd = Number(body?.priceVnd);
  const compareAtVnd = body?.compareAtVnd === "" || body?.compareAtVnd == null ? null : Number(body.compareAtVnd);
  const stock = Number(body?.stock);
  const shortDescription = cleanText(body?.shortDescription, 500);
  const imageUrl = cleanText(body?.imageUrl, 500) || "/assets/watch-placeholder.svg";
  const specificationsText = typeof body?.specifications === "string" ? body.specifications : JSON.stringify(body?.specifications ?? {});
  let specifications;
  try { specifications = JSON.parse(specificationsText); } catch { return { error: "Thông số phải là JSON hợp lệ." }; }
  if (!name || !Number.isSafeInteger(categoryId) || categoryId < 1 || !Number.isSafeInteger(priceVnd) || priceVnd < 1
      || !Number.isSafeInteger(stock) || stock < 0 || (compareAtVnd != null && (!Number.isSafeInteger(compareAtVnd) || compareAtVnd < priceVnd))
      || !imageUrl.startsWith("/assets/") || !specifications || Array.isArray(specifications) || typeof specifications !== "object") {
    return { error: "Kiểm tra tên, danh mục, giá, kho, ảnh (đường dẫn /assets/) và thông số sản phẩm." };
  }
  return { name, slug: productSlug(name), categoryId, priceVnd, compareAtVnd, stock, shortDescription, imageUrl, specifications: JSON.stringify(specifications) };
}

app.post("/api/admin/products", requireUser, requireAdmin, async (request, response) => {
  const data = productInput(request.body);
  if (data.error) return response.status(400).json({ error: data.error });
  try {
    const [result] = await pool.execute(
      `INSERT INTO products (category_id, name, slug, short_description, specifications, price_vnd, compare_at_vnd, stock, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.categoryId, data.name, data.slug, data.shortDescription, data.specifications, data.priceVnd, data.compareAtVnd, data.stock, data.imageUrl],
    );
    response.status(201).json({ id: result.insertId });
  } catch (error) {
    response.status(error.code === "ER_DUP_ENTRY" ? 409 : 400).json({ error: error.code === "ER_DUP_ENTRY" ? "Tên sản phẩm đã tồn tại." : "Chưa lưu được sản phẩm; kiểm tra danh mục." });
  }
});

app.patch("/api/admin/products/:id", requireUser, requireAdmin, async (request, response) => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: "Mã sản phẩm không hợp lệ." });
  if (typeof request.body?.isActive === "boolean") {
    try {
      const [result] = await pool.execute("UPDATE products SET is_active = ? WHERE id = ?", [request.body.isActive, id]);
      return result.affectedRows ? response.json({ ok: true }) : response.status(404).json({ error: "Không tìm thấy sản phẩm." });
    } catch {
      return response.status(503).json({ error: "Chưa cập nhật được sản phẩm." });
    }
  }
  const data = productInput(request.body);
  if (data.error) return response.status(400).json({ error: data.error });
  try {
    const [result] = await pool.execute(
      `UPDATE products SET category_id = ?, name = ?, slug = ?, short_description = ?, specifications = ?,
       price_vnd = ?, compare_at_vnd = ?, stock = ?, image_url = ? WHERE id = ?`,
      [data.categoryId, data.name, data.slug, data.shortDescription, data.specifications, data.priceVnd, data.compareAtVnd, data.stock, data.imageUrl, id],
    );
    response.json({ ok: Boolean(result.affectedRows) });
  } catch (error) {
    response.status(error.code === "ER_DUP_ENTRY" ? 409 : 400).json({ error: error.code === "ER_DUP_ENTRY" ? "Tên sản phẩm đã tồn tại." : "Chưa cập nhật được sản phẩm." });
  }
});

app.post("/api/admin/orders/:id/anchor", requireUser, requireAdmin, async (request, response) => {
  const orderId = Number(request.params.id);
  const txHash = cleanText(request.body?.txHash, 66);
  if (!Number.isSafeInteger(orderId) || orderId < 1 || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return response.status(400).json({ error: "Mã giao dịch không hợp lệ." });
  }
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentFile, "utf8"));
  } catch {
    return response.status(503).json({ error: "Chưa triển khai hợp đồng local. Hãy chạy bước deploy:local." });
  }
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  try {
    const activeChainId = Number(await provider.send("eth_chainId", []));
    if (activeChainId !== chainId || (deployment.chainId != null && Number(deployment.chainId) !== activeChainId)) {
      return response.status(503).json({ error: "Máy chủ blockchain đang dùng sai mạng. Hãy khởi động mạng LabChain Local (Chain ID 31337)." });
    }
    if (await provider.getCode(deployment.address) === "0x") {
      return response.status(503).json({ error: "Không tìm thấy hợp đồng trên mạng hiện tại. Hãy chạy lại lệnh deploy:local." });
    }
    const [orders] = await pool.execute(
      "SELECT id, order_status AS orderStatus, blockchain_key AS blockchainKey, blockchain_digest AS blockchainDigest, blockchain_tx_hash AS blockchainTxHash, blockchain_status AS blockchainStatus FROM orders WHERE id = ? LIMIT 1",
      [orderId],
    );
    const order = orders[0];
    if (!order) return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    if (Number(order.blockchainStatus) === orderStatusCode[order.orderStatus]) return response.status(409).json({ error: "Trạng thái đơn này đã được ghi lên blockchain." });
    const transaction = await provider.getTransaction(txHash);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!transaction || !receipt || receipt.status !== 1 || transaction.to?.toLowerCase() !== deployment.address.toLowerCase()
        || transaction.from.toLowerCase() !== deployment.admin.toLowerCase()) {
      return response.status(400).json({ error: "Giao dịch chưa xác nhận hoặc không được gửi từ ví admin đúng hợp đồng." });
    }
    const iface = new Interface(deployment.abi);
    const parsed = iface.parseTransaction({ data: transaction.data, value: transaction.value });
    const expectedStatus = orderStatusCode[order.orderStatus];
    if (parsed?.name !== "anchorOrder" || parsed.args[0].toLowerCase() !== order.blockchainKey.toLowerCase()
        || parsed.args[1].toLowerCase() !== order.blockchainDigest.toLowerCase() || Number(parsed.args[2]) !== expectedStatus) {
      return response.status(400).json({ error: "Giao dịch blockchain không khớp với mã băm và trạng thái đơn." });
    }
    const emitted = receipt.logs.some((log) => {
      try {
        const event = iface.parseLog(log);
        return event?.name === "OrderAnchored" && event.args.orderKey.toLowerCase() === order.blockchainKey.toLowerCase()
          && event.args.orderDigest.toLowerCase() === order.blockchainDigest.toLowerCase()
          && Number(event.args.status) === expectedStatus;
      } catch { return false; }
    });
    if (!emitted) return response.status(400).json({ error: "Không tìm thấy sự kiện xác nhận trong giao dịch." });
    try {
      await pool.execute("UPDATE orders SET blockchain_tx_hash = ?, blockchain_status = ? WHERE id = ?", [txHash, expectedStatus, orderId]);
    } catch {
      return response.status(503).json({ error: "Giao dịch đã được xác minh trên blockchain nhưng chưa lưu được mã vào MySQL. Hãy kiểm tra MySQL rồi thử lưu lại." });
    }
    response.json({ ok: true, txHash });
  } catch (error) {
    response.status(503).json({ error: error.code === "ECONNREFUSED" ? "Hardhat local chưa chạy. Hãy khởi động mạng LabChain Local." : "Chưa xác minh được giao dịch trên blockchain. Hãy kiểm tra mạng LabChain Local và thử lại." });
  } finally {
    provider.destroy();
  }
});

app.use("/api", (_request, response) => response.status(404).json({ error: "API không tồn tại." }));
app.use("/vendor/ethers", express.static(fileURLToPath(new URL("../node_modules/ethers/dist/", import.meta.url)), { maxAge: "1d" }));
app.use("/vendor/sweetalert2", express.static(fileURLToPath(new URL("../node_modules/sweetalert2/dist/", import.meta.url)), { maxAge: "1d" }));
app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));
app.use((_request, response) => response.status(404).sendFile(fileURLToPath(new URL("../public/404.html", import.meta.url))));
app.use((error, _request, response, _next) => {
  console.error("Request failed:", error.message);
  if (!response.headersSent) response.status(500).json({ error: "Có lỗi nội bộ. Hãy thử lại." });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Xiaomi Watch Store đang chạy tại http://127.0.0.1:${port}`);
});
