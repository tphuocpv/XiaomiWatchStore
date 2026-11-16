export const chainId = 31337;
export const rpcUrl = process.env.LOCALCHAIN_URL ?? "http://127.0.0.1:8545";

export function assertLocalChainRpc(value = rpcUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("LOCALCHAIN_URL không hợp lệ.");
  }
  if (!["http:", "https:"].includes(url.protocol)
      || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
      || url.username || url.password) {
    throw new Error("Ví tự động chỉ được dùng với địa chỉ RPC Hardhat trên máy này.");
  }
}
