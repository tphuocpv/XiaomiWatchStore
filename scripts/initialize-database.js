import "dotenv/config";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { translateDatabaseIdentifiers } from "../database/translate-identifiers.js";

const databaseName = process.env.DB_NAME || "xiaomi_watch_store";

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
  const lockName = createHash("sha256").update(`mitime-schema:${databaseName.toLowerCase()}`).digest("hex");
  const [[lock]] = await connection.execute("SELECT GET_LOCK(?, 30) AS acquired", [lockName]);
  if (lock.acquired !== 1) throw new Error("MySQL đang chạy thiết lập cơ sở dữ liệu ở phiên khác.");

  const forConfiguredDatabase = (sql) => sql.replaceAll("`xiaomi_watch_store`", () => connection.escapeId(databaseName));
  await translateDatabaseIdentifiers(connection, databaseName);
  await connection.query(forConfiguredDatabase(schema));
  const [paymentMethodColumns] = await connection.execute(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'don_hang'
       AND COLUMN_NAME = 'phuong_thuc_thanh_toan'`,
  );
  if (paymentMethodColumns[0] && !paymentMethodColumns[0].COLUMN_TYPE.includes("'crypto'")) {
    await connection.query(
      "ALTER TABLE don_hang MODIFY phuong_thuc_thanh_toan ENUM('vnpay', 'cod', 'crypto') NOT NULL",
    );
  }
  const [cancellationColumns] = await connection.execute(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'don_hang'
       AND COLUMN_NAME = 'yeu_cau_huy_luc'`,
  );
  if (cancellationColumns.length === 0) {
    await connection.query(
      "ALTER TABLE don_hang ADD COLUMN yeu_cau_huy_luc TIMESTAMP NULL DEFAULT NULL AFTER ghi_chu_khach",
    );
  }
  const [products] = await connection.query("SELECT 1 FROM san_pham LIMIT 1");
  if (products.length === 0) await connection.query(forConfiguredDatabase(seed));
  const username = (process.env.ADMIN_USERNAME || "admin").trim();
  const password = process.env.ADMIN_PASSWORD || "Admin@123456";
  if (password.length < 12) throw new Error("ADMIN_PASSWORD cần ít nhất 12 ký tự trong .env.");
  const [rows] = await connection.execute("SELECT ma FROM nguoi_dung WHERE ten_dang_nhap = ? LIMIT 1", [username]);
  if (rows.length) {
    console.log(`Database sẵn sàng; tài khoản admin “${username}” đã có.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await connection.execute(
      "INSERT INTO nguoi_dung (ho_ten, so_dien_thoai, thu_dien_tu, ten_dang_nhap, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?, 'admin')",
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
