import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../server/db.js";

try {
  const username = (process.env.ADMIN_USERNAME ?? "admin").trim();
  const password = process.env.ADMIN_PASSWORD ?? "Admin@12345";
  if (password.length < 12) throw new Error("ADMIN_PASSWORD cần ít nhất 12 ký tự.");

  const [existing] = await pool.execute("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
  if (existing.length) {
    console.log(`Tài khoản admin “${username}” đã tồn tại, giữ nguyên mật khẩu hiện tại.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.execute(
      "INSERT INTO users (full_name, phone, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?, 'admin')",
      ["Quản trị viên", "0000000000", `${username}@local.test`, username, passwordHash],
    );
    console.log(`Đã tạo tài khoản admin local: ${username}`);
  }
} catch (error) {
  console.error(`Không tạo được admin. Kiểm tra MySQL, schema và .env.\n${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
