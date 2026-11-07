import { mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getAddress } from "ethers";

const file = new URL("../data/local-config.json", import.meta.url);
const prompt = createInterface({ input, output });
try {
  const entered = (await prompt.question("Dán địa chỉ ví MetaMask admin (0x...): ")).trim();
  const adminAddress = getAddress(entered);
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(file, `${JSON.stringify({ adminAddress }, null, 2)}\n`, "utf8");
  console.log(`Đã lưu địa chỉ admin cục bộ: ${adminAddress}`);
  console.log("Sau khi triển khai, Hardhat local sẽ cấp ETH thử nghiệm cho đúng địa chỉ này.");
} catch {
  console.error("Địa chỉ ví không hợp lệ; cần có dạng 0x theo MetaMask.");
  process.exitCode = 1;
} finally {
  prompt.close();
}
