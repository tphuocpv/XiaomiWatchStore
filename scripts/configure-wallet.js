import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getAddress } from "ethers";

const file = new URL("../data/local-config.json", import.meta.url);
const prompt = createInterface({ input, output });
try {
  const entered = (await prompt.question("Dán địa chỉ ví nhận tiền của cửa hàng (0x...): ")).trim();
  const merchantAddress = getAddress(entered);
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(file, `${JSON.stringify({ merchantAddress }, null, 2)}\n`, "utf8");
  console.log(`Đã lưu địa chỉ ví nhận tiền cục bộ: ${merchantAddress}`);
} catch {
  console.error("Địa chỉ ví không hợp lệ; cần có dạng 0x theo MetaMask.");
  process.exitCode = 1;
} finally {
  prompt.close();
}
