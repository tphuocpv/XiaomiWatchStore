import "dotenv/config";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256, parseEther, toQuantity, toUtf8Bytes } from "ethers";
import { assertLocalChainRpc, chainId, rpcUrl } from "../local-network.js";

const artifactFile = new URL("../artifacts/contracts/OrderRegistry.sol/OrderRegistry.json", import.meta.url);
const escrowArtifactFile = new URL("../artifacts/contracts/OrderEscrow.sol/OrderEscrow.json", import.meta.url);
const outputDir = new URL("../public/", import.meta.url);
const deploymentFile = new URL("deployment.json", outputDir);
const dataDir = new URL("../data/", import.meta.url);
const localConfigFile = new URL("local-config.json", dataDir);
let provider;

async function optionalJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function walletFromEnv(name) {
  const key = process.env[name]?.trim();
  if (!key || key === "generate-with-setup") {
    throw new Error(`Thiếu ${name} trong .env. Hãy chạy npm run setup trước.`);
  }
  try {
    return new Wallet(key);
  } catch {
    throw new Error(`${name} trong .env không hợp lệ.`);
  }
}

async function deployedAt(contract) {
  const receipt = await contract.deploymentTransaction().wait();
  return { address: await contract.getAddress(), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
}

async function ensureUnfundedEscrow(address) {
  if (address && await provider.getBalance(address, "latest") > 0n) {
    throw new Error("Hợp đồng hiện tại còn giữ ETH thử nghiệm. Hãy hoàn tất hoặc hoàn tiền các đơn đã trả trước khi thay hợp đồng.");
  }
}

async function deploy() {
  assertLocalChainRpc();
  provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true, cacheTimeout: -1 });
  const [connectedChainId, metadata] = await Promise.all([
    provider.send("eth_chainId", []),
    provider.send("hardhat_metadata", []),
  ]);
  if (Number(connectedChainId) !== chainId || Number(metadata?.chainId) !== chainId || !metadata?.instanceId) {
    throw new Error("Hardhat phải chạy với Chain ID 31337.");
  }
  const { instanceId } = metadata;
  const { abi, bytecode } = JSON.parse(await readFile(artifactFile, "utf8"));
  const escrowArtifact = JSON.parse(await readFile(escrowArtifactFile, "utf8"));
  const deployer = await provider.getSigner(0);
  const config = await optionalJson(localConfigFile);
  const merchant = getAddress(config?.merchantAddress ?? config?.adminAddress ?? await deployer.getAddress());
  const admin = walletFromEnv("CRYPTO_AUTOMATION_PRIVATE_KEY").address;
  const quoteSigner = walletFromEnv("CRYPTO_QUOTE_PRIVATE_KEY").address;
  if (admin === quoteSigner || admin === merchant) {
    throw new Error("Ví tự động phải khác ví ký báo giá và ví nhận tiền.");
  }

  const artifactHash = keccak256(toUtf8Bytes(JSON.stringify({
    bytecode, escrowBytecode: escrowArtifact.bytecode, admin, quoteSigner, merchant,
  })));
  const previous = await optionalJson(deploymentFile);
  const [existingCode, existingEscrowCode] = await Promise.all([
    previous?.address ? provider.getCode(previous.address) : "0x",
    previous?.escrow?.address ? provider.getCode(previous.escrow.address) : "0x",
  ]);
  const reuse = previous?.artifactHash === artifactHash && previous.instanceId === instanceId
    && existingCode !== "0x" && existingEscrowCode !== "0x";
  const oldEscrowAddress = !reuse && existingEscrowCode !== "0x" ? previous.escrow.address : null;
  await ensureUnfundedEscrow(oldEscrowAddress);

  if (await provider.getBalance(admin) < parseEther("1")) {
    await provider.send("hardhat_setBalance", [admin, toQuantity(parseEther("10"))]);
  }
  if (config && await provider.getBalance(merchant) === 0n) {
    await provider.send("hardhat_setBalance", [merchant, toQuantity(parseEther("10"))]);
  }
  if (reuse) {
    console.log(`OrderRegistry: ${previous.address} (đang dùng)\nOrderEscrow: ${previous.escrow.address} (đang dùng)`);
    console.log(`Ví tự động: ${admin}\nVí nhận tiền: ${merchant}`);
    return;
  }

  const contract = await new ContractFactory(abi, bytecode, deployer).deploy(admin);
  const registry = await deployedAt(contract);
  const escrowContract = await new ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, deployer)
    .deploy(admin, quoteSigner, merchant);
  const escrow = await deployedAt(escrowContract);
  const previousDeployments = [];
  if (previous) {
    const { previousDeployments: archive = [], ...snapshot } = previous;
    previousDeployments.push(snapshot, ...archive);
  }

  await Promise.all([mkdir(outputDir, { recursive: true }), mkdir(dataDir, { recursive: true })]);
  const temporaryDeployment = new URL(`deployment-${randomUUID()}.json`, dataDir);
  await writeFile(temporaryDeployment, JSON.stringify({
    address: registry.address, abi, admin, merchant, artifactHash, chainId, instanceId, quoteSigner,
    registryBlockNumber: registry.blockNumber, registryBlockHash: registry.blockHash,
    escrow: { ...escrow, abi: escrowArtifact.abi },
    previousDeployments,
  }, null, 2) + "\n", { flag: "wx" });
  await ensureUnfundedEscrow(oldEscrowAddress);
  await rename(temporaryDeployment, deploymentFile);
  console.log(`OrderRegistry: ${registry.address}\nOrderEscrow: ${escrow.address}`);
  console.log(`Ví tự động: ${admin}\nVí nhận tiền: ${merchant}`);
}

try {
  await deploy();
} catch (error) {
  console.error(`Không thể triển khai OrderRegistry. Kiểm tra Hardhat node.\n${error.shortMessage ?? error.message}`);
  process.exitCode = 1;
} finally {
  provider?.destroy();
}
