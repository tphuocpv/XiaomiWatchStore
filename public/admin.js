import { installVietnameseValidation, vietnameseError } from "./error-messages.js";
import { confirmAction, showToast } from "./notifications.js";
import { submitAdminEscrowAction } from "./crypto-wallet.js";

const $ = (selector) => document.querySelector(selector);
const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const orderStates = [
  ["pending", "Chờ xử lý"], ["confirmed", "Đã xác nhận"], ["packing", "Đang đóng gói"],
  ["shipped", "Đang giao"], ["delivered", "Đã giao"], ["cancelled", "Đã hủy"],
];
let deployment = null;
let walletAccount = null;
let categories = [];
let users = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin", cache: "no-store", ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Yêu cầu chưa hoàn tất.");
  return data;
}

function announce(message, error = false) {
  const node = $("#admin-message");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.hidden = false;
}

function emptyNode(message) {
  const node = document.createElement("div");
  node.className = "empty-admin";
  node.textContent = message;
  return node;
}

function selectOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function formatSpecifications(value) {
  let specifications = value;
  if (typeof specifications === "string") {
    try { specifications = JSON.parse(specifications); } catch { specifications = {}; }
  }
  if (!specifications || typeof specifications !== "object" || Array.isArray(specifications)) return "";
  return Object.entries(specifications)
    .map(([name, detail]) => `${name}: ${Array.isArray(detail) ? detail.join(", ") : detail}`)
    .join("\n");
}

function parseSpecifications(value) {
  const specifications = {};
  for (const line of value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf(":");
    if (separator < 1 || !line.slice(separator + 1).trim()) {
      throw new Error("Mỗi dòng thông số cần có dạng “Tên thông số: Nội dung”.");
    }
    specifications[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  if (!Object.keys(specifications).length) throw new Error("Vui lòng nhập ít nhất một thông số kỹ thuật.");
  return specifications;
}

async function loadDeployment() {
  try {
    const response = await fetch("/deployment.json", { cache: "no-store" });
    if (!response.ok) throw new Error("missing");
    deployment = await response.json();
    $("#wallet-status").textContent = walletAccount
      ? `Đã kết nối ${walletAccount}`
      : `Hợp đồng đã triển khai · Admin: ${deployment.admin}`;
  } catch {
    deployment = null;
    $("#wallet-status").textContent = "Tích hợp blockchain chưa sẵn sàng. Vui lòng thử lại sau.";
  }
}

async function loadOrders() {
  const target = $("#admin-orders");
  target.replaceChildren(emptyNode("Đang tải đơn hàng…"));
  try {
    const { orders } = await api("/api/admin/orders");
    $("#stat-orders").textContent = String(orders.length);
    $("#stat-pending").textContent = String(orders.filter((order) => order.orderStatus === "pending").length);
    target.replaceChildren();
    if (!orders.length) return target.append(emptyNode("Chưa có đơn hàng."));
    for (const order of orders) target.append(renderOrder(order));
  } catch (error) {
    target.replaceChildren(emptyNode(vietnameseError(error, "Chưa tải được đơn hàng.")));
  }
}

function renderUsers() {
  const target = $("#admin-users");
  const query = $("#users-search").value.trim().toLocaleLowerCase("vi");
  const filtered = users.filter((user) => [user.fullName, user.username, user.phone, user.email, user.address]
    .some((value) => String(value ?? "").toLocaleLowerCase("vi").includes(query)));
  target.replaceChildren();
  if (!filtered.length) {
    const row = document.createElement("tr");
    row.className = "table-empty-row";
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = users.length ? "Không tìm thấy người dùng phù hợp." : "Chưa có tài khoản khách hàng.";
    row.append(cell);
    target.append(row);
    return;
  }
  for (const user of filtered) {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    identity.className = "user-identity";
    const name = document.createElement("strong");
    name.textContent = user.fullName;
    const username = document.createElement("small");
    username.textContent = `@${user.username}`;
    identity.append(name, username);
    const contact = document.createElement("td");
    contact.className = "user-contact";
    const email = document.createElement("span");
    email.textContent = user.email;
    const phone = document.createElement("small");
    phone.textContent = user.phone;
    contact.append(email, phone);
    const orderCount = document.createElement("td");
    orderCount.textContent = String(user.orderCount ?? 0);
    const joined = document.createElement("td");
    joined.textContent = user.createdAt ? new Date(user.createdAt).toLocaleDateString("vi-VN") : "—";
    const actions = document.createElement("td");
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "table-action";
    edit.textContent = "Chỉnh sửa";
    edit.addEventListener("click", () => openUserEditor(user));
    actions.append(edit);
    row.append(identity, contact, orderCount, joined, actions);
    target.append(row);
  }
}

async function loadUsers() {
  const target = $("#admin-users");
  target.replaceChildren();
  const loading = document.createElement("tr");
  loading.className = "table-empty-row";
  const cell = document.createElement("td");
  cell.colSpan = 5;
  cell.textContent = "Đang tải danh sách người dùng…";
  loading.append(cell);
  target.append(loading);
  $("#admin-users-message").textContent = "";
  try {
    const result = await api("/api/admin/users");
    users = result.users;
    $("#stat-users").textContent = String(users.length);
    renderUsers();
  } catch (error) {
    users = [];
    $("#stat-users").textContent = "—";
    target.replaceChildren();
    const row = document.createElement("tr");
    row.className = "table-empty-row";
    const errorCell = document.createElement("td");
    errorCell.colSpan = 5;
    errorCell.textContent = vietnameseError(error, "Chưa tải được danh sách người dùng.");
    row.append(errorCell);
    target.append(row);
  }
}

function openUserEditor(user) {
  const form = $("#user-form");
  form.elements.id.value = user.id;
  form.elements.fullName.value = user.fullName ?? "";
  form.elements.username.value = user.username ?? "";
  form.elements.phone.value = user.phone ?? "";
  form.elements.email.value = user.email ?? "";
  form.elements.address.value = user.address ?? "";
  $("#user-dialog-title").textContent = `Cập nhật ${user.fullName}`;
  $("#user-form-message").textContent = "";
  $("#user-dialog").showModal();
}

function renderOrder(order) {
  const card = document.createElement("article");
  card.className = "admin-order-card";
  const top = document.createElement("div");
  top.className = "admin-order-top";
  const description = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = `${order.orderCode} · ${currency.format(Number(order.totalVnd))}`;
  const details = document.createElement("p");
  const paymentLabels = { unpaid: "Chưa thanh toán", paid: "Đã thanh toán", failed: "Thanh toán lỗi", refunded: "Đã hoàn tiền" };
  const paymentMethodLabels = { cod: "Thanh toán khi nhận", vnpay: "VNPay (thử nghiệm)", crypto: "ETH qua MetaMask" };
  details.textContent = `${new Date(order.createdAt).toLocaleString("vi-VN")} · ${paymentMethodLabels[order.paymentMethod] || "Chưa rõ phương thức"} · ${paymentLabels[order.paymentStatus] || "Chưa cập nhật"}`;
  description.append(heading, details);
  const current = document.createElement("span");
  current.className = "product-category";
  current.textContent = orderStates.find(([code]) => code === order.orderStatus)?.[1] || order.orderStatus;
  top.append(description, current);

  const address = document.createElement("p");
  address.className = "admin-order-address";
  address.textContent = `Người nhận: ${order.shippingName} · ${order.shippingPhone} · ${order.shippingAddress}`;

  const items = document.createElement("ul");
  items.className = "admin-order-items";
  for (const item of order.items ?? []) {
    const line = document.createElement("li");
    line.textContent = `${item.productName} · ${item.quantity} × ${currency.format(Number(item.unitPriceVnd))}`;
    items.append(line);
  }

  const controls = document.createElement("div");
  controls.className = "order-controls";
  let cancellationPanel = null;
  let refundPanel = null;
  const status = document.createElement("select");
  status.setAttribute("aria-label", `Trạng thái đơn ${order.orderCode}`);
  const electronicUnpaid = ["vnpay", "crypto"].includes(order.paymentMethod) && order.paymentStatus !== "paid";
  const vnpayPendingUntil = order.vnpayPendingUntil ? new Date(order.vnpayPendingUntil) : null;
  const vnpayAttemptActive = order.paymentMethod === "vnpay" && order.paymentStatus === "unpaid"
    && vnpayPendingUntil && vnpayPendingUntil.getTime() > Date.now();
  for (const [code, label] of orderStates) {
    selectOption(status, code, label);
    if (electronicUnpaid && ["confirmed", "packing", "shipped", "delivered"].includes(code)) {
      status.lastElementChild.disabled = true;
    }
    if (code === "cancelled" && vnpayAttemptActive) status.lastElementChild.disabled = true;
    if (order.paymentMethod === "crypto" && code === "cancelled") status.lastElementChild.disabled = true;
  }
  if (vnpayAttemptActive) status.title = "Chờ phiên VNPay hiện tại hoàn tất hoặc hết hạn trước khi hủy đơn.";
  else if (electronicUnpaid) status.title = "Chờ xác nhận thanh toán điện tử trước khi xử lý đơn.";
  status.value = order.orderStatus;
  const saveStatus = document.createElement("button");
  saveStatus.type = "button";
  saveStatus.className = "secondary-button";
  saveStatus.textContent = "Cập nhật đơn";
  status.disabled = Boolean(order.cancellationRequestedAt);
  saveStatus.disabled = Boolean(order.cancellationRequestedAt);
  saveStatus.addEventListener("click", async () => {
    try {
      if (status.value === order.orderStatus) return;
      if (order.paymentMethod === "crypto" && status.value === "shipped") {
        announce("Hãy xác nhận chuyển trạng thái sang đang giao trong MetaMask…");
        await recordCryptoAdminAction(order, "mark-shipped", "markShipped");
      } else if (order.paymentMethod === "crypto" && status.value === "delivered") {
        announce("Hãy xác nhận giải ngân ETH trong MetaMask…");
        await recordCryptoAdminAction(order, "release", "releaseOrder");
      } else {
        await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ orderStatus: status.value }) });
      }
      announce(`Đã cập nhật đơn ${order.orderCode}.`);
      await loadOrders();
    } catch (error) { announce(vietnameseError(error, "Chưa cập nhật được đơn hàng."), true); }
  });
  controls.append(status, saveStatus);
  if (order.cancellationRequestedAt) {
    const cancellation = document.createElement("section");
    cancellationPanel = cancellation;
    cancellation.className = "order-cancellation-request";
    const cancellationTitle = document.createElement("strong");
    cancellationTitle.textContent = "Khách hàng đã gửi yêu cầu hủy đơn";
    const cancellationDate = document.createElement("small");
    cancellationDate.textContent = `Gửi lúc ${new Date(order.cancellationRequestedAt).toLocaleString("vi-VN")}`;
    const cancellationActions = document.createElement("div");
    cancellationActions.className = "order-cancellation-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "secondary-button";
    approve.textContent = order.paymentMethod === "crypto"
      ? order.cryptoStatus === "escrowed" ? "Hoàn ETH và duyệt hủy"
        : order.cryptoStatus === "refunded" ? "Hoàn tất duyệt hủy"
          : order.cryptoStatus === "cancelled" ? "Duyệt hủy đơn" : "Khóa thanh toán và duyệt hủy"
      : order.paymentStatus === "paid" ? "Xác nhận hoàn tiền và hủy" : "Duyệt hủy đơn";
    approve.addEventListener("click", () => resolveCancellationRequest(order, "approve", approve));
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "secondary-button";
    decline.textContent = "Từ chối yêu cầu";
    decline.addEventListener("click", () => resolveCancellationRequest(order, "decline", decline));
    cancellationActions.append(approve, decline);
    cancellation.append(cancellationTitle, cancellationDate, cancellationActions);
  }
  if (order.paymentMethod === "cod" && order.paymentStatus !== "paid" && order.orderStatus === "delivered") {
    const paid = document.createElement("button");
    paid.type = "button";
    paid.className = "secondary-button";
    paid.textContent = "Xác nhận đã thu COD";
    paid.addEventListener("click", async () => {
      try {
        await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ paymentStatus: "paid" }) });
        announce(`Đã cập nhật thanh toán COD cho ${order.orderCode}.`);
        await loadOrders();
      } catch (error) { announce(vietnameseError(error, "Chưa cập nhật được thanh toán COD."), true); }
    });
    controls.append(paid);
  }

  if (order.paymentMethod === "vnpay" && order.orderStatus === "cancelled" && order.paymentStatus === "paid") {
    refundPanel = document.createElement("section");
    refundPanel.className = "order-cancellation-request";
    const warning = document.createElement("strong");
    warning.textContent = "VNPay báo thanh toán thành công sau khi đơn đã hủy";
    const note = document.createElement("small");
    note.textContent = "Hãy hoàn tiền trên cổng VNPay Sandbox trước, sau đó xác nhận để cập nhật sổ đơn hàng.";
    const refundActions = document.createElement("div");
    refundActions.className = "order-cancellation-actions";
    const refund = document.createElement("button");
    refund.type = "button";
    refund.className = "secondary-button";
    refund.textContent = "Ghi nhận đã hoàn tiền VNPay";
    refund.addEventListener("click", async () => {
      if (!await confirmAction({
        title: "Xác nhận đã hoàn tiền VNPay?",
        text: "Chỉ tiếp tục sau khi khoản tiền đã được hoàn trên VNPay Sandbox. MiTime sẽ cập nhật trạng thái đối soát.",
        confirmText: "Đã hoàn tiền",
      })) return;
      refund.disabled = true;
      try {
        await api(`/api/admin/orders/${order.id}/payments/vnpay/refund-confirmation`, {
          method: "POST", body: JSON.stringify({ refundProcessed: true }),
        });
        showToast({ title: `Đã ghi nhận hoàn tiền cho đơn ${order.orderCode}.` });
        await loadOrders();
      } catch (error) {
        refund.disabled = false;
        showToast({ title: vietnameseError(error, "Chưa ghi nhận được khoản hoàn tiền."), icon: "error", timer: 5200 });
      }
    });
    refundActions.append(refund);
    refundPanel.append(warning, note, refundActions);
  }

  const proof = document.createElement("div");
  proof.className = "order-proof";
  const proofText = document.createElement("div");
  const currentCode = orderStates.findIndex(([code]) => code === order.orderStatus) + 1;
  const recorded = Number(order.blockchainStatus) === currentCode;
  proofText.textContent = recorded
    ? `Đã ghi nhận trạng thái “${orderStates[currentCode - 1]?.[1]}” trên blockchain.`
    : "Trạng thái đơn hiện tại chưa có bằng chứng blockchain.";
  const digest = document.createElement("small");
  digest.textContent = `Mã băm đơn: ${order.blockchainDigest}`;
  proof.append(proofText, digest);
  if (order.paymentMethod === "crypto") {
    const cryptoDetails = document.createElement("small");
    const amountEth = order.cryptoAmountWei && window.ethers ? window.ethers.formatEther(order.cryptoAmountWei) : "chưa có báo giá";
    cryptoDetails.textContent = `Escrow: ${order.cryptoStatus || "chưa khởi tạo"} · ${amountEth} ETH thử nghiệm`;
    proof.append(cryptoDetails);
    if (order.cryptoPaymentTxHash) {
      const paymentTx = document.createElement("small");
      paymentTx.textContent = `Mã thanh toán: ${order.cryptoPaymentTxHash}`;
      proof.append(paymentTx);
    }
    const escrowTx = order.cryptoReleaseTxHash || order.cryptoRefundTxHash || order.cryptoShipTxHash;
    if (escrowTx) {
      const actionTx = document.createElement("small");
      actionTx.textContent = `Mã giao dịch escrow gần nhất: ${escrowTx}`;
      proof.append(actionTx);
    }
  }
  if (order.blockchainTxHash) {
    const tx = document.createElement("small");
    tx.textContent = `Giao dịch gần nhất: ${order.blockchainTxHash}`;
    proof.append(tx);
  }
  if (!recorded) {
    const anchor = document.createElement("button");
    anchor.type = "button";
    anchor.className = "proof-button";
    anchor.textContent = order.blockchainTxHash ? "Ghi trạng thái mới bằng MetaMask" : "Ghi dấu đơn bằng MetaMask";
    anchor.disabled = !deployment;
    anchor.addEventListener("click", () => anchorOrder(order, anchor));
    proof.append(anchor);
  }

  card.append(top, address);
  if (items.childElementCount) card.append(items);
  if (cancellationPanel) card.append(cancellationPanel);
  if (refundPanel) card.append(refundPanel);
  card.append(controls, proof);
  return card;
}

async function resolveCancellationRequest(order, action, button) {
  const paid = order.paymentStatus === "paid";
  const prompt = action === "approve"
    ? order.paymentMethod === "crypto"
      ? order.cryptoStatus === "escrowed"
        ? "MetaMask sẽ hoàn ETH về ví khách. Chỉ hủy sau khi giao dịch hoàn tiền được xác nhận."
        : order.cryptoStatus === "unpaid"
          ? "MetaMask sẽ đánh dấu mã đơn đã hủy để ngăn giao dịch ETH đến muộn."
          : "Hoàn tất yêu cầu hủy đã có giao dịch escrow xác nhận."
      : paid
      ? "Chỉ tiếp tục sau khi đã xử lý hoàn tiền. Hệ thống sẽ ghi nhận đơn là đã hoàn tiền và hủy đơn."
      : "Duyệt yêu cầu hủy và trả sản phẩm về tồn kho?"
    : "Từ chối yêu cầu hủy này? Khách hàng có thể gửi yêu cầu mới nếu đơn chưa chuyển sang giao hàng.";
  if (!await confirmAction({
    title: action === "approve" ? "Xác nhận duyệt hủy đơn?" : "Từ chối yêu cầu hủy?",
    text: prompt,
    confirmText: action === "approve" ? "Duyệt hủy đơn" : "Từ chối yêu cầu",
  })) return;
  button.disabled = true;
  let pendingActionKey = null;
  try {
    if (action === "approve" && order.paymentMethod === "crypto") {
      if (order.cryptoStatus === "escrowed" && order.paymentStatus === "paid") {
        pendingActionKey = await recordCryptoAdminAction(order, "refund", "refundOrder", true);
      } else if (order.cryptoStatus === "unpaid" && order.paymentStatus === "unpaid") {
        pendingActionKey = await recordCryptoAdminAction(order, "cancel-unpaid", "cancelUnpaidOrder", true);
      } else if (!["refunded", "cancelled"].includes(order.cryptoStatus)) {
        throw new Error("Trạng thái escrow không phù hợp để duyệt hủy. Hãy tải lại danh sách đơn.");
      }
    }
    await api(`/api/admin/orders/${order.id}/cancellation-request`, {
      method: "POST",
      body: JSON.stringify({
        action,
        refundConfirmed: action === "approve" && order.paymentStatus === "paid" && order.paymentMethod !== "crypto",
      }),
    });
    if (pendingActionKey) localStorage.removeItem(pendingActionKey);
    showToast({ title: action === "approve" ? `Đã xử lý hủy đơn ${order.orderCode}.` : `Đã từ chối yêu cầu ${order.orderCode}.` });
    await loadOrders();
  } catch (error) {
    button.disabled = false;
    showToast({ title: vietnameseError(error, "Chưa xử lý được yêu cầu hủy đơn."), icon: "error", timer: 5200 });
  }
}

async function recordCryptoAdminAction(order, action, contractMethod, keepForFollowUp = false) {
  const storageKey = `miwatch-admin-escrow-${order.id}-${action}`;
  let txHash = localStorage.getItem(storageKey);
  if (!txHash) {
    txHash = await submitAdminEscrowAction(order.blockchainKey, contractMethod);
    localStorage.setItem(storageKey, txHash);
  }
  await api(`/api/admin/orders/${order.id}/payments/crypto/action`, {
    method: "POST", body: JSON.stringify({ action, txHash }),
  });
  if (!keepForFollowUp) localStorage.removeItem(storageKey);
  return storageKey;
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("Chrome chưa thấy tiện ích MetaMask. Hãy mở MetaMask và tải lại trang này.");
  if (!deployment) await loadDeployment();
  if (!deployment) throw new Error("Tích hợp blockchain chưa sẵn sàng. Vui lòng kiểm tra cấu hình hệ thống.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  walletAccount = accounts[0];
  if (walletAccount.toLowerCase() !== deployment.admin.toLowerCase()) {
    throw new Error(`Ví đang chọn chưa phải ví admin của hợp đồng. Địa chỉ cần dùng: ${deployment.admin}`);
  }
  let chain = await window.ethereum.request({ method: "eth_chainId" });
  if (chain !== "0x7a69") {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
    } catch (error) {
      if (error.code !== 4902) throw error;
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
        chainId: "0x7a69", chainName: "LabChain Local", rpcUrls: ["http://127.0.0.1:8545"],
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      }] });
    }
    chain = await window.ethereum.request({ method: "eth_chainId" });
  }
  if (chain !== "0x7a69") throw new Error("MetaMask chưa kết nối với mạng LabChain Local. Vui lòng kiểm tra mạng đang chọn.");
  const contractCode = await window.ethereum.request({ method: "eth_getCode", params: [deployment.address, "latest"] });
  if (!contractCode || contractCode === "0x") {
    throw new Error("Không tìm thấy hợp đồng trên mạng LabChain Local. Vui lòng kiểm tra cấu hình mạng.");
  }
  $("#wallet-status").textContent = `Đã kết nối ví admin ${walletAccount}`;
  return walletAccount;
}

async function waitForReceipt(txHash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("Giao dịch không được xác nhận trên blockchain.");
      return receipt;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error("Chưa nhận được xác nhận giao dịch. Vui lòng kiểm tra MetaMask và thử lại.");
}

async function anchorOrder(order, button) {
  button.disabled = true;
  try {
    const from = await connectWallet();
    const status = orderStates.findIndex(([code]) => code === order.orderStatus) + 1;
    const data = `0x9e6378b6${order.blockchainKey.slice(2)}${order.blockchainDigest.slice(2)}${status.toString(16).padStart(64, "0")}`;
    const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to: deployment.address, data, value: "0x0" }] });
    announce("Đã gửi yêu cầu. Vui lòng xác nhận giao dịch trong MetaMask…");
    await waitForReceipt(txHash);
    await api(`/api/admin/orders/${order.id}/anchor`, { method: "POST", body: JSON.stringify({ txHash }) });
    announce(`Đã ghi nhận bằng chứng blockchain cho đơn ${order.orderCode}. Mã giao dịch: ${txHash}`);
    await loadOrders();
  } catch (error) {
    announce(vietnameseError(error, "Chưa ghi được giao dịch blockchain."), true);
    button.disabled = false;
  }
}

async function loadCategories() {
  const result = await api("/api/admin/categories");
  categories = result.categories;
  const select = $("#product-form [name=categoryId]");
  select.replaceChildren();
  for (const category of categories) selectOption(select, String(category.id), category.name);

  const list = $("#admin-categories");
  list.replaceChildren();
  if (!categories.length) list.append(emptyNode("Chưa có danh mục."));
  for (const category of categories) {
    const card = document.createElement("article");
    card.className = "admin-product-card";
    const top = document.createElement("div");
    top.className = "admin-product-top";
    const info = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = category.name;
    const description = document.createElement("p");
    description.textContent = category.description || `Đường dẫn: /${category.slug}`;
    info.append(name, description);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Sửa danh mục";
    edit.addEventListener("click", () => {
      populateCategoryForm(category);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    const actions = document.createElement("div");
    actions.className = "admin-product-actions";
    actions.append(edit);
    top.append(info, actions);
    card.append(top);
    list.append(card);
  }
}

function populateCategoryForm(category) {
  const form = $("#category-form");
  form.elements.id.value = category?.id ?? "";
  form.elements.name.value = category?.name ?? "";
  form.elements.description.value = category?.description ?? "";
  $("#category-form-title").textContent = category ? `Sửa danh mục #${category.id}` : "Thêm danh mục";
  $("#category-message").textContent = "";
}

function populateProductForm(product) {
  const form = $("#product-form");
  form.elements.id.value = product?.id ?? "";
  form.elements.name.value = product?.name ?? "";
  form.elements.categoryId.value = String(product?.categoryId ?? categories[0]?.id ?? "");
  form.elements.priceVnd.value = product?.priceVnd ?? "";
  form.elements.compareAtVnd.value = product?.compareAtVnd ?? "";
  form.elements.stock.value = product?.stock ?? "";
  form.elements.imageUrl.value = product?.imageUrl ?? "/assets/watch-placeholder.svg";
  form.elements.shortDescription.value = product?.shortDescription ?? "";
  form.elements.specifications.value = formatSpecifications(
    product?.specifications ?? { "Màn hình": "AMOLED", "Định vị": "GNSS tích hợp" },
  );
  $("#product-form-title").textContent = product ? `Sửa sản phẩm #${product.id}` : "Thêm sản phẩm";
  $("#product-message").textContent = "";
}

async function loadProducts() {
  const target = $("#admin-products");
  target.replaceChildren(emptyNode("Đang tải sản phẩm…"));
  try {
    await loadCategories();
    const { products } = await api("/api/admin/products");
    $("#stat-products").textContent = String(products.length);
    target.replaceChildren();
    if (!products.length) return target.append(emptyNode("Chưa có sản phẩm."));
    for (const product of products) {
      const card = document.createElement("article");
      card.className = "admin-product-card";
      const top = document.createElement("div");
      top.className = "admin-product-top";
      const info = document.createElement("div");
      const name = document.createElement("h3");
      name.textContent = product.name;
      const description = document.createElement("p");
      description.textContent = `${currency.format(Number(product.priceVnd))} · Tồn kho ${product.stock} · ${categories.find((row) => row.id === product.categoryId)?.name || "Danh mục"} · ${product.isActive ? "Đang bán" : "Đã ẩn"}`;
      info.append(name, description);
      const actions = document.createElement("div");
      actions.className = "admin-product-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "Sửa";
      edit.addEventListener("click", () => {
        populateProductForm(product);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = product.isActive ? "Ẩn" : "Hiện";
      toggle.addEventListener("click", async () => {
        try {
          await api(`/api/admin/products/${product.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !product.isActive }) });
          await loadProducts();
        } catch (error) { announce(vietnameseError(error, "Chưa cập nhật được sản phẩm."), true); }
      });
      actions.append(edit, toggle);
      top.append(info, actions);
      card.append(top);
      target.append(card);
    }
  } catch (error) {
    $("#stat-products").textContent = "—";
    target.replaceChildren(emptyNode(vietnameseError(error, "Chưa tải được sản phẩm.")));
  }
}

async function initialize() {
  try {
    const { user } = await api("/api/auth/me");
    if (user?.role !== "admin") {
      $("#admin-login-needed").hidden = false;
      $("#admin-user").textContent = "Chưa đăng nhập admin";
      return;
    }
    $("#admin-user").textContent = `Xin chào, ${user.fullName}`;
    $("#admin-logout").hidden = false;
    $("#admin-dashboard").hidden = false;
    await Promise.all([loadDeployment(), loadOrders(), loadProducts(), loadUsers()]);
  } catch (error) {
    $("#admin-login-needed").hidden = false;
    $("#admin-user").textContent = "Chưa thể kiểm tra đăng nhập";
    announce(vietnameseError(error, "Chưa kiểm tra được phiên đăng nhập."), true);
  }
}

document.querySelectorAll("[data-panel]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-panel]").forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".admin-panel").forEach((panel) => {
      panel.hidden = panel.id !== `${button.dataset.panel}-panel`;
    });
  });
});

$("#wallet-connect").addEventListener("click", async () => {
  try { await connectWallet(); announce("Đã kết nối ví quản trị với mạng blockchain."); }
  catch (error) { announce(vietnameseError(error, "Chưa kết nối được MetaMask."), true); }
});
$("#orders-reload").addEventListener("click", loadOrders);
$("#users-reload").addEventListener("click", loadUsers);
$("#products-reload").addEventListener("click", loadProducts);
$("#users-search").addEventListener("input", renderUsers);
$("#user-dialog-close").addEventListener("click", () => $("#user-dialog").close());
$("#user-cancel").addEventListener("click", () => $("#user-dialog").close());
$("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const body = {
    fullName: form.elements.fullName.value,
    phone: form.elements.phone.value,
    email: form.elements.email.value,
    address: form.elements.address.value,
  };
  try {
    await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    $("#user-dialog").close();
    announce("Đã cập nhật thông tin người dùng.");
    await loadUsers();
  } catch (error) {
    $("#user-form-message").textContent = vietnameseError(error, "Chưa cập nhật được người dùng.");
  }
});
$("#admin-logout").addEventListener("click", async () => {
  if (!await confirmAction({
    title: "Đăng xuất khỏi trang quản trị?",
    text: "Bạn sẽ trở về trang cửa hàng sau khi đăng xuất.",
    confirmText: "Đăng xuất",
  })) return;
  try {
    await api("/api/auth/logout", { method: "POST" });
    window.location.assign("/?notice=logged-out");
  } catch (error) { showToast({ title: vietnameseError(error, "Chưa đăng xuất được."), icon: "error", timer: 5200 }); }
});
$("#product-reset").addEventListener("click", () => populateProductForm(null));
$("#category-reset").addEventListener("click", () => populateCategoryForm(null));
$("#category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const body = { name: form.elements.name.value, description: form.elements.description.value };
  try {
    await api(id ? `/api/admin/categories/${id}` : "/api/admin/categories", {
      method: id ? "PATCH" : "POST", body: JSON.stringify(body),
    });
    populateCategoryForm(null);
    $("#category-message").textContent = id ? "Đã cập nhật danh mục." : "Đã thêm danh mục.";
    await loadProducts();
  } catch (error) { $("#category-message").textContent = vietnameseError(error, "Chưa lưu được danh mục."); }
});
$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const body = Object.fromEntries(new FormData(form).entries());
  delete body.id;
  try {
    body.specifications = parseSpecifications(body.specifications);
  } catch (error) {
    $("#product-message").textContent = error.message;
    return;
  }
  try {
    const result = await api(id ? `/api/admin/products/${id}` : "/api/admin/products", {
      method: id ? "PATCH" : "POST", body: JSON.stringify(body),
    });
    $("#product-message").textContent = id ? "Đã cập nhật sản phẩm." : `Đã thêm sản phẩm #${result.id}.`;
    populateProductForm(null);
    await loadProducts();
  } catch (error) { $("#product-message").textContent = vietnameseError(error, "Chưa lưu được sản phẩm."); }
});

initialize();
installVietnameseValidation();
