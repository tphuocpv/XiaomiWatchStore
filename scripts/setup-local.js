import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import { Wallet } from "ethers";

const example = new URL("../.env.example", import.meta.url);
const local = new URL("../.env", import.meta.url);

let exists = true;
const original = await readFile(local, "utf8").catch(async (error) => {
  if (error.code !== "ENOENT") throw error;
  exists = false;
  return readFile(example, "utf8");
});
let contents = exists ? original : original.replace(
  "replace-with-a-long-random-local-secret", randomBytes(48).toString("base64url"),
);
const env = parse(contents);
for (const name of ["CRYPTO_QUOTE_PRIVATE_KEY", "CRYPTO_AUTOMATION_PRIVATE_KEY"]) {
  const value = env[name];
  if (value && value !== "generate-with-setup") {
    try {
      new Wallet(value);
    } catch {
      throw new Error(`${name} trong .env không hợp lệ.`);
    }
    continue;
  }
  const existing = new RegExp(`^[ \t]*(?:export[ \t]+)?${name}[ \t]*=.*$`, "gm");
  const assignment = `${name}=${Wallet.createRandom().privateKey}`;
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  contents = existing.test(contents)
    ? contents.replace(existing, assignment)
    : `${contents.trimEnd()}${newline}${assignment}${newline}`;
}

if (contents !== original || !exists) {
  await writeFile(local, contents, { encoding: "utf8", flag: exists ? "w" : "wx" });
  console.log("Đã lưu cấu hình và khóa ví blockchain cục bộ trong .env.");
} else {
  console.log("Đã có cấu hình và khóa ví blockchain cục bộ trong .env.");
}
