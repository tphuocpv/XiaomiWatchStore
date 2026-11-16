import "dotenv/config";
import bcrypt from "bcryptjs";
import { pool } from "../server/db.js";

try {
  const username = (process.env.ADMIN_USERNAME ?? "admin").trim();
  const password = process.env.ADMIN_PASSWORD ?? "Admin@123456";
  if (password.length < 12) throw new Error("ADMIN_PASSWORD cần ít nhất 12 ký tự.");

  const [existing] = await pool.execute("SELECT ma AS id FROM nguoi_dung WHERE ten_dang_nhap = ? LIMIT 1", [username]);
  if (existing.length) {
    console.log(`Tài khoản admin “${username}” đã tồn tại, giữ nguyên mật khẩu hiện tại.`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.execute(
      "INSERT INTO nguoi_dung (ho_ten, so_dien_thoai, thu_dien_tu, ten_dang_nhap, mat_khau_bam, vai_tro) VALUES (?, ?, ?, ?, ?, 'admin')",
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
