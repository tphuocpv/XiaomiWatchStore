import "dotenv/config";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { readFile } from "node:fs/promises";

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  charset: "utf8mb4",
  multipleStatements: true,
});

try {
  const schema = await readFile(new URL("../database/schema.sql", import.meta.url), "utf8");
  const seed = await readFile(new URL("../database/seed.sql", import.meta.url), "utf8");
  await connection.query(schema);
  const [cancellationColumns] = await connection.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = 'xiaomi_watch_store' AND TABLE_NAME = 'orders'
       AND COLUMN_NAME = 'cancellation_requested_at'`,
  );
  if (cancellationColumns.length === 0) {
    await connection.query(
      "ALTER TABLE xiaomi_watch_store.orders ADD COLUMN cancellation_requested_at TIMESTAMP NULL DEFAULT NULL AFTER customer_note",
    );
  }
  await connection.query(seed);
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = process.env.ADMIN_PASSWORD || "Admin@123456";
  if (password.length < 12) throw new Error("ADMIN_PASSWORD cần ít nhất 12 ký tự trong .env.");
  const [rows] = await connection.execute("SELECT id FROM xiaomi_watch_store.users WHERE username = ? LIMIT 1", [username]);
  if (rows.length) {
    console.log(`Database sẵn sàng; tài khoản admin “${username}” đã có.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await connection.execute(
      "INSERT INTO xiaomi_watch_store.users (full_name, phone, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, 'admin')",
      ["Quản trị viên", "0000000000", `${username}@local.test`, username, passwordHash],
    );
    console.log(`Đã tạo database, dữ liệu mẫu và tài khoản admin “${username}”.`);
  }
} catch (error) {
  console.error(`Chưa khởi tạo được database. Kiểm tra MySQL và các dòng DB_* trong .env.\n${error.message}`);
  process.exitCode = 1;
} finally {
  await connection.end();
}
