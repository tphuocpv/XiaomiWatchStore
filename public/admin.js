const $ = (selector) => document.querySelector(selector);
const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const orderStates = [
  ["pending", "Chờ xử lý"], ["confirmed", "Đã xác nhận"], ["packing", "Đang đóng gói"],
  ["shipped", "Đang giao"], ["delivered", "Đã giao"], ["cancelled", "Đã hủy"],
];
let deployment = null;
let walletAccount = null;
let categories = [];

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
    $("#wallet-status").textContent = "Chưa triển khai hợp đồng local. Hãy chạy npm run chain và npm run deploy:local.";
  }
}

async function loadOrders() {
  const target = $("#admin-orders");
  target.replaceChildren(emptyNode("Đang tải đơn hàng…"));
  try {
    const { orders } = await api("/api/admin/orders");
    target.replaceChildren();
    if (!orders.length) return target.append(emptyNode("Chưa có đơn hàng."));
    for (const order of orders) target.append(renderOrder(order));
  } catch (error) {
    target.replaceChildren(emptyNode(error.message));
  }
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
  details.textContent = `${new Date(order.createdAt).toLocaleString("vi-VN")} · ${order.paymentMethod === "cod" ? "Thanh toán khi nhận" : "VNPay sandbox"} · ${order.paymentStatus === "paid" ? "Đã thanh toán" : order.paymentStatus === "failed" ? "Thanh toán lỗi" : "Chưa thanh toán"}`;
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
  const status = document.createElement("select");
  status.setAttribute("aria-label", `Trạng thái đơn ${order.orderCode}`);
  const vnpayUnpaid = order.paymentMethod === "vnpay" && order.paymentStatus !== "paid";
  for (const [code, label] of orderStates) {
    selectOption(status, code, label);
    if (vnpayUnpaid && ["confirmed", "packing", "shipped", "delivered"].includes(code)) {
      status.lastElementChild.disabled = true;
    }
  }
  if (vnpayUnpaid) status.title = "Chờ VNPay xác nhận thanh toán trước khi xử lý đơn.";
  status.value = order.orderStatus;
  const saveStatus = document.createElement("button");
  saveStatus.type = "button";
  saveStatus.className = "secondary-button";
  saveStatus.textContent = "Cập nhật đơn";
  saveStatus.addEventListener("click", async () => {
    try {
      await api(`/api/admin/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ orderStatus: status.value }) });
      announce(`Đã cập nhật đơn ${order.orderCode}. Ghi trạng thái mới lên blockchain khi cần.`);
      await loadOrders();
    } catch (error) { announce(error.message, true); }
  });
  controls.append(status, saveStatus);
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
      } catch (error) { announce(error.message, true); }
    });
    controls.append(paid);
  }

  const proof = document.createElement("div");
  proof.className = "order-proof";
  const proofText = document.createElement("div");
  const currentCode = orderStates.findIndex(([code]) => code === order.orderStatus) + 1;
  const recorded = Number(order.blockchainStatus) === currentCode;
  proofText.textContent = recorded
    ? `Blockchain đã ghi trạng thái “${orderStates[currentCode - 1]?.[1]}”.`
    : "Trạng thái đơn hiện tại chưa được ghi lên blockchain.";
  const digest = document.createElement("small");
  digest.textContent = `Mã băm đơn: ${order.blockchainDigest}`;
  proof.append(proofText, digest);
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
  card.append(controls, proof);
  return card;
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("Chrome chưa thấy tiện ích MetaMask. Hãy mở MetaMask và tải lại trang này.");
  if (!deployment) await loadDeployment();
  if (!deployment) throw new Error("Chưa có hợp đồng. Hãy chạy Hardhat local và lệnh deploy trước.");
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
  if (chain !== "0x7a69") throw new Error("Hãy chọn mạng LabChain Local (Chain ID 31337) trong MetaMask.");
  $("#wallet-status").textContent = `Đã kết nối ví admin ${walletAccount}`;
  return walletAccount;
}

async function waitForReceipt(txHash) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await window.ethereum.request({ method: "eth_getTransactionReceipt", params: [txHash] });
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error("Giao dịch bị từ chối trên blockchain local.");
      return receipt;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
  }
  throw new Error("Chưa thấy giao dịch được xác nhận. Kiểm tra cửa sổ Hardhat local.");
}

async function anchorOrder(order, button) {
  button.disabled = true;
  try {
    const from = await connectWallet();
    const status = orderStates.findIndex(([code]) => code === order.orderStatus) + 1;
    const data = `0x9e6378b6${order.blockchainKey.slice(2)}${order.blockchainDigest.slice(2)}${status.toString(16).padStart(64, "0")}`;
    const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to: deployment.address, data, value: "0x0" }] });
    announce("Đã gửi giao dịch. Chờ MetaMask/Hardhat xác nhận…");
    await waitForReceipt(txHash);
    await api(`/api/admin/orders/${order.id}/anchor`, { method: "POST", body: JSON.stringify({ txHash }) });
    announce(`Đã ghi nhận đơn ${order.orderCode} lên blockchain local. Mã giao dịch: ${txHash}`);
    await loadOrders();
  } catch (error) {
    announce(error.message || "Chưa ghi được giao dịch blockchain.", true);
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
  const specifications = typeof product?.specifications === "string"
    ? product.specifications : JSON.stringify(product?.specifications ?? { "Màn hình": "AMOLED", GPS: "Có" }, null, 2);
  form.elements.specifications.value = specifications;
  $("#product-form-title").textContent = product ? `Sửa sản phẩm #${product.id}` : "Thêm sản phẩm";
  $("#product-message").textContent = "";
}

async function loadProducts() {
  const target = $("#admin-products");
  target.replaceChildren(emptyNode("Đang tải sản phẩm…"));
  try {
    await loadCategories();
    const { products } = await api("/api/admin/products");
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
        } catch (error) { announce(error.message, true); }
      });
      actions.append(edit, toggle);
      top.append(info, actions);
      card.append(top);
      target.append(card);
    }
  } catch (error) {
    target.replaceChildren(emptyNode(error.message));
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
    $("#admin-dashboard").hidden = false;
    await Promise.all([loadDeployment(), loadOrders(), loadProducts()]);
  } catch (error) {
    $("#admin-login-needed").hidden = false;
    $("#admin-user").textContent = "Chưa thể kiểm tra đăng nhập";
    announce(error.message, true);
  }
}

document.querySelectorAll("[data-panel]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-panel]").forEach((tab) => tab.classList.toggle("active", tab === button));
    $("#orders-panel").hidden = button.dataset.panel !== "orders";
    $("#products-panel").hidden = button.dataset.panel !== "products";
  });
});

$("#wallet-connect").addEventListener("click", async () => {
  try { await connectWallet(); announce("Đã kết nối ví admin với mạng LabChain Local."); }
  catch (error) { announce(error.message, true); }
});
$("#orders-reload").addEventListener("click", loadOrders);
$("#products-reload").addEventListener("click", loadProducts);
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
  } catch (error) { $("#category-message").textContent = error.message; }
});
$("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const body = Object.fromEntries(new FormData(form).entries());
  delete body.id;
  try {
    const result = await api(id ? `/api/admin/products/${id}` : "/api/admin/products", {
      method: id ? "PATCH" : "POST", body: JSON.stringify(body),
    });
    $("#product-message").textContent = id ? "Đã cập nhật sản phẩm." : `Đã thêm sản phẩm #${result.id}.`;
    populateProductForm(null);
    await loadProducts();
  } catch (error) { $("#product-message").textContent = error.message; }
});

initialize();
