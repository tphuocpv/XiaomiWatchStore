import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ContractFactory, JsonRpcProvider, getAddress, keccak256, parseEther, toQuantity } from "ethers";
import { chainId, rpcUrl } from "../local-network.js";

const artifactFile = new URL("../artifacts/contracts/OrderRegistry.sol/OrderRegistry.json", import.meta.url);
const outputDir = new URL("../public/", import.meta.url);
const deploymentFile = new URL("deployment.json", outputDir);
const localConfigFile = new URL("../data/local-config.json", import.meta.url);
const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });

async function optionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function deploy() {
  if (Number(await provider.send("eth_chainId", [])) !== chainId) {
    throw new Error("Hardhat phải chạy với Chain ID 31337.");
  }
  const { abi, bytecode } = JSON.parse(await readFile(artifactFile, "utf8"));
  const deployer = await provider.getSigner(0);
  const config = await optionalJson(localConfigFile);
  const admin = config ? getAddress(config.adminAddress) : getAddress(await deployer.getAddress());
  if (config && await provider.getBalance(admin) < parseEther("1")) {
    await provider.send("hardhat_setBalance", [admin, toQuantity(parseEther("10"))]);
  }

  const artifactHash = keccak256(bytecode);
  const previous = await optionalJson(deploymentFile);
  const existingCode = previous ? await provider.getCode(previous.address) : "0x";
  if (previous?.artifactHash === artifactHash && previous.admin === admin && existingCode !== "0x") {
    if (previous.chainId !== chainId) {
      await writeFile(deploymentFile, JSON.stringify({ ...previous, chainId }, null, 2) + "\n");
    }
    console.log(`OrderRegistry: ${previous.address} (đang dùng)\nAdmin ví: ${admin}`);
    return;
  }

  const contract = await new ContractFactory(abi, bytecode, deployer).deploy(admin);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  await mkdir(outputDir, { recursive: true });
  await writeFile(deploymentFile, JSON.stringify({ address, abi, admin, artifactHash, chainId }, null, 2) + "\n");
  console.log(`OrderRegistry: ${address}\nAdmin ví: ${admin}`);
}

try {
  await deploy();
} catch (error) {
  console.error(`Không thể triển khai OrderRegistry. Kiểm tra Hardhat node.\n${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
} finally {
  provider.destroy();
}
