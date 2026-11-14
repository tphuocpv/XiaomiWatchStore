async function readDeployment() {
  const response = await fetch("/deployment.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Chưa tìm thấy hợp đồng thanh toán. Hãy chạy bước triển khai local.");
  const deployment = await response.json();
  if (!deployment.escrow?.address || !Array.isArray(deployment.escrow?.abi)) {
    throw new Error("Hợp đồng escrow chưa được triển khai. Hãy chạy deploy:local.");
  }
  return deployment;
}

export async function connectEscrowWallet({ adminOnly = false } = {}) {
  if (!window.ethereum) throw new Error("Chrome chưa thấy MetaMask. Hãy cài và mở tiện ích rồi thử lại.");
  if (!window.ethers) throw new Error("Thư viện ví chưa tải xong. Hãy tải lại trang rồi thử lại.");
  const deployment = await readDeployment();
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const account = accounts[0];
  if (!account) throw new Error("Chưa chọn tài khoản MetaMask.");
  if (adminOnly && account.toLowerCase() !== deployment.admin.toLowerCase()) {
    throw new Error(`Hãy chọn ví quản trị ${deployment.admin} trong MetaMask.`);
  }

  let currentChain = await window.ethereum.request({ method: "eth_chainId" });
  if (currentChain !== "0x7a69") {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
    } catch (error) {
      if (error.code !== 4902) throw error;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: "0x7a69", chainName: "LabChain Local", rpcUrls: ["http://127.0.0.1:8545"],
        nativeCurrency: { name: "Ether thử nghiệm", symbol: "ETH", decimals: 18 },
      }] });
    }
    currentChain = await window.ethereum.request({ method: "eth_chainId" });
  }
  if (currentChain !== "0x7a69") throw new Error("Hãy chuyển MetaMask sang mạng LabChain Local (Chain ID 31337).");
  const code = await window.ethereum.request({ method: "eth_getCode", params: [deployment.escrow.address, "latest"] });
  if (!code || code === "0x") throw new Error("Không tìm thấy hợp đồng escrow. Hãy chạy lại deploy:local.");

  const provider = new window.ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const contract = new window.ethers.Contract(deployment.escrow.address, deployment.escrow.abi, signer);
  return { account, deployment, contract };
}

export async function submitCryptoPayment(order, quote, onSubmitted = () => {}) {
  try {
    const { contract } = await connectEscrowWallet();
    const amount = BigInt(quote.amountWei);
    const transaction = await contract.payOrder(
      order.blockchainKey || quote.orderKey, order.blockchainDigest || quote.invoiceHash,
      amount, quote.deadline, quote.signature, { value: amount },
    );
    onSubmitted(transaction.hash);
    await transaction.wait();
    return transaction.hash;
  } catch (error) {
    if (error.code === 4001) throw new Error("Bạn đã từ chối giao dịch trong MetaMask.");
    if (error.code === -32002) throw new Error("MetaMask đang có yêu cầu chờ xác nhận. Hãy mở ví và xử lý yêu cầu đó.");
    throw error;
  }
}

export async function submitAdminEscrowAction(orderKey, method) {
  try {
    const { contract } = await connectEscrowWallet({ adminOnly: true });
    const transaction = await contract[method](orderKey);
    await transaction.wait();
    return transaction.hash;
  } catch (error) {
    if (error.code === 4001) throw new Error("Bạn đã từ chối giao dịch trong MetaMask.");
    if (error.code === -32002) throw new Error("MetaMask đang có yêu cầu chờ xác nhận. Hãy mở ví và xử lý yêu cầu đó.");
    throw error;
  }
}
