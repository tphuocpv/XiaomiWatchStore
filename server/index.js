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
  const orderCode = cleanText(search.get("vnp_TxnRef"), 32);
  const [rows] = await pool.execute(
    "SELECT id, total_vnd AS totalVnd, payment_status AS paymentStatus, order_status AS orderStatus FROM orders WHERE order_code = ? LIMIT 1",
    [orderCode],
  );
  const order = rows[0];
  if (!order) return { found: false };
  if (Number(search.get("vnp_Amount")) !== Number(order.totalVnd) * 100) return { found: true, invalidAmount: true };

  const success = search.get("vnp_ResponseCode") === "00" && search.get("vnp_TransactionStatus") === "00";
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [lockedRows] = await connection.execute(
      "SELECT payment_status AS paymentStatus, order_status AS orderStatus FROM orders WHERE id = ? FOR UPDATE", [order.id],
    );
    const status = lockedRows[0]?.paymentStatus;
    if (status === "paid") {
      await connection.execute(
        "UPDATE payment_attempts SET response_code = ?, secure_hash_valid = TRUE WHERE transaction_ref = ?",
        [search.get("vnp_ResponseCode"), orderCode],
      );
      await connection.commit();
      return { found: true, alreadyPaid: true, success: true };
    }
    if (status !== "failed" && status !== "refunded") {
      if (success) {
        await connection.execute(
          "UPDATE orders SET payment_status = 'paid', order_status = CASE WHEN order_status = 'cancelled' THEN 'cancelled' ELSE 'confirmed' END WHERE id = ?", [order.id],
        );
      } else {
        await connection.execute(
          "UPDATE orders SET payment_status = 'failed', order_status = 'cancelled' WHERE id = ?", [order.id],
        );
        if (lockedRows[0]?.orderStatus !== "cancelled") {
          const [items] = await connection.execute(
            "SELECT product_id AS productId, quantity FROM order_items WHERE order_id = ?", [order.id],
          );
          for (const item of items) {
            if (item.productId != null) {
              await connection.execute("UPDATE products SET stock = stock + ? WHERE id = ?", [item.quantity, item.productId]);
            }
          }
        }
      }
    }
    await connection.execute(
      "UPDATE payment_attempts SET response_code = ?, secure_hash_valid = TRUE WHERE transaction_ref = ?",
      [search.get("vnp_ResponseCode"), orderCode],
    );
    await connection.commit();
    return { found: true, success };
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
    response.json({ status: "ok", mysql: "connected", vnpaySandboxConfigured: hasVnpayCredentials() });
  } catch {
    response.status(503).json({ status: "needs-setup", mysql: "disconnected" });
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
  if (!shippingName || !validPhone(shippingPhone) || !shippingAddress || !["cod", "vnpay"].includes(paymentMethod)
      || !Array.isArray(requested) || requested.length < 1 || requested.length > 20) {
    return response.status(400).json({ error: "Kiểm tra thông tin nhận hàng, cách thanh toán và sản phẩm trong giỏ." });
  }
  if (paymentMethod === "vnpay" && !hasVnpayCredentials()) {
    return response.status(503).json({ error: "Muốn dùng VNPay sandbox cần điền TmnCode và HashSecret do VNPay cấp trong tệp .env. Bạn vẫn có thể đặt đơn bằng COD." });
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
    let paymentUrl = null;
    if (paymentMethod === "vnpay") {
      await connection.execute(
        "INSERT INTO payment_attempts (order_id, provider, transaction_ref) VALUES (?, 'vnpay', ?)",
        [insert.insertId, orderCode],
      );
      paymentUrl = createVnpayUrl({ orderCode, amountVnd: subtotal, clientIp: request.ip || "127.0.0.1" });
    }
    await connection.commit();
    response.status(201).json({
      order: { id: insert.insertId, orderCode, totalVnd: subtotal, paymentMethod, paymentStatus: "unpaid", orderStatus: "pending", blockchainKey: orderKey, blockchainDigest: orderDigest },
      paymentUrl,
    });
  } catch (error) {
    await connection.rollback();
    response.status(error.status ?? 503).json({ error: error.status ? error.message : "Chưa tạo được đơn. Kiểm tra lại MySQL rồi thử lại." });
  } finally {
    connection.release();
  }
});

app.get("/api/orders", requireUser, async (request, response) => {
  try {
    const [orders] = await pool.execute(
      `SELECT id, order_code AS orderCode, total_vnd AS totalVnd, payment_method AS paymentMethod,
        payment_status AS paymentStatus, order_status AS orderStatus, blockchain_digest AS blockchainDigest,
        blockchain_tx_hash AS blockchainTxHash, blockchain_status AS blockchainStatus, created_at AS createdAt
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [request.session.user.id],
    );
    response.json({ orders });
  } catch {
    response.status(503).json({ error: "Chưa đọc được lịch sử đơn hàng." });
  }
});

app.get("/api/payments/vnpay/return", async (request, response) => {
  const { search, valid } = parseVnpayRequest(request);
  const orderCode = cleanText(search.get("vnp_TxnRef"), 32);
  if (!valid) return response.redirect(`/?payment=invalid&order=${encodeURIComponent(orderCode)}`);
  try {
    const result = await applyVnpayResult(search);
    const state = !result.found || result.invalidAmount ? "invalid" : result.success ? "success" : "failed";
    response.redirect(`/?payment=${state}&order=${encodeURIComponent(orderCode)}`);
  } catch {
    response.redirect(`/?payment=error&order=${encodeURIComponent(orderCode)}`);
  }
});

app.get("/api/payments/vnpay/ipn", async (request, response) => {
  const { search, valid } = parseVnpayRequest(request);
  if (!valid) return response.json({ RspCode: "97", Message: "Invalid signature" });
  try {
    const result = await applyVnpayResult(search);
    if (!result.found) return response.json({ RspCode: "01", Message: "Order not found" });
    if (result.invalidAmount) return response.json({ RspCode: "04", Message: "Invalid amount" });
    response.json({ RspCode: "00", Message: result.alreadyPaid ? "Order already confirmed" : "Confirm Success" });
  } catch {
    response.json({ RspCode: "99", Message: "Unknown error" });
  }
});

app.get("/api/admin/orders", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [orders] = await pool.execute(
      `SELECT id, order_code AS orderCode, total_vnd AS totalVnd, payment_method AS paymentMethod,
        payment_status AS paymentStatus, order_status AS orderStatus, shipping_name AS shippingName,
        shipping_phone AS shippingPhone, shipping_address AS shippingAddress, blockchain_key AS blockchainKey,
        blockchain_digest AS blockchainDigest, blockchain_tx_hash AS blockchainTxHash,
        blockchain_status AS blockchainStatus, created_at AS createdAt
       FROM orders ORDER BY created_at DESC LIMIT 100`,
    );
    response.json({ orders });
  } catch {
    response.status(503).json({ error: "Chưa đọc được đơn hàng từ MySQL." });
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
      "SELECT order_status AS orderStatus, payment_status AS paymentStatus, payment_method AS paymentMethod FROM orders WHERE id = ? FOR UPDATE", [id],
    );
    const order = rows[0];
    if (!order) {
      await connection.rollback();
      return response.status(404).json({ error: "Không tìm thấy đơn hàng." });
    }
    if (orderStatus) {
      if (!orderTransitions[order.orderStatus]?.has(orderStatus)) {
        await connection.rollback();
        return response.status(409).json({ error: "Không thể chuyển đơn theo thứ tự này. Hãy xử lý trạng thái hiện tại trước." });
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

app.get("/api/admin/categories", requireUser, requireAdmin, async (_request, response) => {
  try {
    const [categories] = await pool.execute("SELECT id, name, slug FROM categories ORDER BY name");
    response.json({ categories });
  } catch {
    response.status(503).json({ error: "Chưa đọc được danh mục." });
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
    await pool.execute("UPDATE orders SET blockchain_tx_hash = ?, blockchain_status = ? WHERE id = ?", [txHash, expectedStatus, orderId]);
    response.json({ ok: true, txHash });
  } catch (error) {
    response.status(503).json({ error: error.code === "ECONNREFUSED" ? "Hardhat local chưa chạy." : "Chưa xác minh được giao dịch trên blockchain." });
  } finally {
    provider.destroy();
  }
});

app.use("/api", (_request, response) => response.status(404).json({ error: "API không tồn tại." }));
app.use(express.static(fileURLToPath(new URL("../public/", import.meta.url)), { extensions: ["html"] }));
app.use((error, _request, response, _next) => {
  console.error("Request failed:", error.message);
  if (!response.headersSent) response.status(500).json({ error: "Có lỗi nội bộ. Hãy thử lại." });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`Xiaomi Watch Store đang chạy tại http://127.0.0.1:${port}`);
});
