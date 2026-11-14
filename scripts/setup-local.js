import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Wallet } from "ethers";

const example = new URL("../.env.example", import.meta.url);
const local = new URL("../.env", import.meta.url);
try {
  let contents = await readFile(local, "utf8");
  if (!/^CRYPTO_QUOTE_PRIVATE_KEY=0x[0-9a-fA-F]{64}$/m.test(contents)) {
    const key = Wallet.createRandom().privateKey;
    if (/^CRYPTO_QUOTE_PRIVATE_KEY\s*=/m.test(contents)) {
      contents = contents.replace(/^CRYPTO_QUOTE_PRIVATE_KEY\s*=.*$/m, `CRYPTO_QUOTE_PRIVATE_KEY=${key}`);
    } else {
      contents = `${contents.trimEnd()}\nCRYPTO_QUOTE_PRIVATE_KEY=${key}\n`;
    }
    await writeFile(local, contents, "utf8");
    console.log("Đã thêm khóa ký báo giá riêng cho mạng local vào .env; khóa này không được đưa lên GitHub.");
  } else {
    console.log("Đã có .env local; giữ nguyên cấu hình hiện tại.");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const template = await readFile(example, "utf8");
  const contents = template
    .replace("replace-with-a-long-random-local-secret", randomBytes(48).toString("base64url"))
    .replace("generate-with-setup", Wallet.createRandom().privateKey);
  await writeFile(local, contents, { encoding: "utf8", flag: "wx" });
  console.log("Đã tạo .env local với session secret và khóa ký báo giá riêng. Tệp này không được đẩy lên GitHub.");
}
