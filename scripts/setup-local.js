import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const example = new URL("../.env.example", import.meta.url);
const local = new URL("../.env", import.meta.url);
try {
  await readFile(local);
  console.log("Đã có .env local; giữ nguyên cấu hình hiện tại.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const template = await readFile(example, "utf8");
  const contents = template.replace("replace-with-a-long-random-local-secret", randomBytes(48).toString("base64url"));
  await writeFile(local, contents, { encoding: "utf8", flag: "wx" });
  console.log("Đã tạo .env local với session secret ngẫu nhiên. Tệp này không được đẩy lên GitHub.");
}
