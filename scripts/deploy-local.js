import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256, parseEther, toQuantity } from "ethers";
import { chainId, rpcUrl } from "../local-network.js";

const artifactFile = new URL("../artifacts/contracts/OrderRegistry.sol/OrderRegistry.json", import.meta.url);
const escrowArtifactFile = new URL("../artifacts/contracts/OrderEscrow.sol/OrderEscrow.json", import.meta.url);
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
  const escrowArtifact = JSON.parse(await readFile(escrowArtifactFile, "utf8"));
  const deployer = await provider.getSigner(0);
  const config = await optionalJson(localConfigFile);
  const admin = config ? getAddress(config.adminAddress) : getAddress(await deployer.getAddress());
  const quotePrivateKey = process.env.CRYPTO_QUOTE_PRIVATE_KEY?.trim();
  if (!quotePrivateKey) throw new Error("Thiếu CRYPTO_QUOTE_PRIVATE_KEY trong .env. Hãy chạy npm run setup trước.");
  const quoteSigner = new Wallet(quotePrivateKey).address;
  if (config && await provider.getBalance(admin) < parseEther("1")) {
    await provider.send("hardhat_setBalance", [admin, toQuantity(parseEther("10"))]);
  }

  const artifactHash = keccak256(`${bytecode}${escrowArtifact.bytecode}${admin}${quoteSigner}`);
  const previous = await optionalJson(deploymentFile);
  const existingCode = previous ? await provider.getCode(previous.address) : "0x";
  const existingEscrowCode = previous?.escrow?.address ? await provider.getCode(previous.escrow.address) : "0x";
  if (previous?.artifactHash === artifactHash && previous.admin === admin
      && previous.quoteSigner === quoteSigner && existingCode !== "0x" && existingEscrowCode !== "0x") {
    if (previous.chainId !== chainId) {
      await writeFile(deploymentFile, JSON.stringify({ ...previous, chainId }, null, 2) + "\n");
    }
    console.log(`OrderRegistry: ${previous.address} (đang dùng)\nAdmin ví: ${admin}`);
    return;
  }

  const contract = await new ContractFactory(abi, bytecode, deployer).deploy(admin);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const escrowContract = await new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, deployer).deploy(admin, quoteSigner);
  await escrowContract.waitForDeployment();
  const escrowAddress = await escrowContract.getAddress();
  await mkdir(outputDir, { recursive: true });
  await writeFile(deploymentFile, JSON.stringify({
    address, abi, admin, artifactHash, chainId,
    quoteSigner, escrow: { address: escrowAddress, abi: escrowArtifact.abi },
  }, null, 2) + "\n");
  console.log(`OrderRegistry: ${address}\nOrderEscrow: ${escrowAddress}\nAdmin ví: ${admin}`);
}

try {
  await deploy();
} catch (error) {
  console.error(`Không thể triển khai OrderRegistry. Kiểm tra Hardhat node.\n${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
} finally {
  provider.destroy();
}
