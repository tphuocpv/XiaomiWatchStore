async function readDeployment() {
  const response = await fetch("/deployment.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Thanh toán bằng ETH hiện chưa khả dụng. Vui lòng thử lại sau.");
  const deployment = await response.json();
  if (!deployment.escrow?.address || !Array.isArray(deployment.escrow?.abi)) {
    throw new Error("Thanh toán bằng ETH hiện chưa khả dụng. Vui lòng thử lại sau.");
  }
  return deployment;
}

const localChainId = "0x7a69";
let sendingTransaction = false;

async function connectLocalWallet() {
  if (!window.ethereum) throw new Error("Chrome chưa thấy MetaMask. Hãy cài và mở tiện ích rồi thử lại.");
  const authorizedAccounts = await window.ethereum.request({ method: "eth_accounts" });
  if (!authorizedAccounts.length) await window.ethereum.request({ method: "eth_requestAccounts" });

  let currentChain = await window.ethereum.request({ method: "eth_chainId" });
  if (currentChain !== localChainId) {
    const switchParams = [{ chainId: localChainId }];
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: switchParams });
    } catch (error) {
      if (error.code !== 4902 && error.data?.originalError?.code !== 4902) throw error;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: localChainId, chainName: "LabChain Local", rpcUrls: ["http://127.0.0.1:8545"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      }] });
      if (await window.ethereum.request({ method: "eth_chainId" }) !== localChainId) {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: switchParams });
      }
    }
    currentChain = await window.ethereum.request({ method: "eth_chainId" });
  }
  if (currentChain !== localChainId) throw new Error("Hãy chuyển MetaMask sang mạng LabChain Local (Chain ID 31337).");
  const [account] = await window.ethereum.request({ method: "eth_accounts" });
  if (!account) throw new Error("Chưa chọn tài khoản MetaMask.");
  return account;
}

async function sendLocalTransaction({ from, to, abi, method, args, value, onSubmitted }) {
  if (sendingTransaction) throw new Error("Hãy xử lý giao dịch đang mở trong MetaMask trước.");
  sendingTransaction = true;
  try {
    if (!window.ethers) throw new Error("Chưa thể mở ví. Hãy tải lại trang rồi thử lại.");
    const chain = await window.ethereum.request({ method: "eth_chainId" });
    if (chain !== localChainId) throw new Error("Hãy chuyển MetaMask sang mạng LabChain Local (Chain ID 31337).");
    const code = await window.ethereum.request({ method: "eth_getCode", params: [to, "latest"] });
    if (!code || code === "0x") throw new Error("Thanh toán bằng ETH hiện chưa khả dụng. Vui lòng thử lại sau.");
    const data = new window.ethers.Interface(abi).encodeFunctionData(method, args);
    // Hardhat mines immediately. The latest block gives the nonce even if MetaMask kept older activity.
    const nonce = await window.ethereum.request({ method: "eth_getTransactionCount", params: [from, "latest"] });
    if (await window.ethereum.request({ method: "eth_chainId" }) !== localChainId) {
      throw new Error("MetaMask đã đổi mạng. Hãy chọn lại LabChain Local trước khi gửi giao dịch.");
    }
    const txHash = await window.ethereum.request({
      method: "eth_sendTransaction",
      params: [{ from, to, data, value: window.ethers.toQuantity(value), nonce, chainId: localChainId }],
    });
    onSubmitted?.(txHash);
    const provider = new window.ethers.BrowserProvider(window.ethereum);
    try {
      const receipt = await provider.waitForTransaction(txHash, 1, 60_000);
      if (!receipt || receipt.status !== 1) {
        throw Object.assign(new Error("Hợp đồng đã từ chối giao dịch. Hãy tải lại đơn hàng rồi thử lại."), { code: "LOCAL_TX_REVERTED" });
      }
    } finally {
      provider.destroy();
    }
    return txHash;
  } catch (error) {
    if (error.code === 4001) throw new Error("Bạn đã từ chối giao dịch trong MetaMask.");
    if (error.code === -32002) throw new Error("MetaMask đang có yêu cầu chờ xác nhận. Hãy mở ví và xử lý yêu cầu đó.");
    throw error;
  } finally {
    sendingTransaction = false;
  }
}

export async function submitCryptoPayment(quote, onSubmitted) {
  const { escrow } = await readDeployment();
  if (Number(quote.chainId) !== Number(localChainId) || quote.contractAddress.toLowerCase() !== escrow.address.toLowerCase()) {
    throw new Error("Hợp đồng vừa thay đổi. Hãy thanh toán lại để nhận báo giá mới.");
  }
  const from = await connectLocalWallet();
  const value = BigInt(quote.amountWei);
  return sendLocalTransaction({
    from, to: escrow.address, abi: escrow.abi, method: "payOrder", value, onSubmitted,
    args: [quote.orderKey, quote.invoiceHash, value, quote.deadline, quote.signature],
  });
}
