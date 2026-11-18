import { installVietnameseValidation, vietnameseError } from "./error-messages.js";
import { confirmAction, showNotice, showToast } from "./notifications.js";
import { submitCryptoPayment } from "./crypto-wallet.js";

const state = {
  products: [],
  catalogFailed: false,
  category: "all",
  search: "",
  sort: "featured",
  cart: readCart(),
  user: null,
  cryptoPaymentOrderId: null,
};

const $ = (selector) => document.querySelector(selector);
const grid = $("#product-grid");
const cartDrawer = $("#cart-drawer");
const scrim = $("#scrim");
const accountDialog = $("#account-dialog");
const checkoutDialog = $("#checkout-dialog");
const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const orderLabels = { pending: "Chờ xử lý", confirmed: "Đã xác nhận", packing: "Đang đóng gói", shipped: "Đang giao", delivered: "Đã giao", cancelled: "Đã hủy" };
const cryptoOrdersBeingConfirmed = new Set();
let ordersRevision = 0;

function readCart() {
  try {
    const value = JSON.parse(localStorage.getItem("miwatch-cart") || "[]");
    return Array.isArray(value) ? value.filter((item) => Number.isSafeInteger(item.id) && Number.isSafeInteger(item.quantity) && item.quantity > 0) : [];
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem("miwatch-cart", JSON.stringify(state.cart));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || "Yêu cầu chưa hoàn tất."), { code: data.code });
  return data;
}

function productImage(product) {
  return typeof product.imageUrl === "string" && product.imageUrl.startsWith("/")
    ? product.imageUrl : "/assets/watch-placeholder.svg";
}

function productSpecs(product) {
  let values = product.specifications;
  if (typeof values === "string") {
    try { values = JSON.parse(values); } catch { values = {}; }
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) return "";
  return Object.entries(values).slice(0, 3).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join(" · ");
}

function renderCategories() {
  const categories = [];
  for (const product of state.products) {
    if (!categories.some((item) => item.slug === product.categorySlug)) {
      categories.push({ slug: product.categorySlug, name: product.categoryName });
    }
  }
  const all = [{ slug: "all", name: "Tất cả sản phẩm" }, ...categories];
  const list = $("#category-list");
  list.replaceChildren();
  for (const category of all) {
    const button = document.createElement("button");
    button.className = "category-chip" + (state.category === category.slug ? " active" : "");
    button.type = "button";
    button.textContent = category.name;
    button.addEventListener("click", () => {
      state.category = category.slug;
      renderCategories();
      renderProducts();
    });
    list.append(button);
  }
}

function filteredProducts() {
  let products = state.products.filter((product) => {
    const categoryMatch = state.category === "all" || product.categorySlug === state.category;
    const query = state.search.toLocaleLowerCase("vi");
    const searchMatch = !query || (product.name + " " + product.shortDescription).toLocaleLowerCase("vi").includes(query);
    return categoryMatch && searchMatch;
  });
  if (state.sort === "price-asc") products = products.toSorted((a, b) => Number(a.priceVnd) - Number(b.priceVnd));
  if (state.sort === "price-desc") products = products.toSorted((a, b) => Number(b.priceVnd) - Number(a.priceVnd));
  return products;
}

function renderProducts() {
  const products = filteredProducts();
  grid.replaceChildren();
  const emptyState = $("#empty-products");
  emptyState.textContent = state.catalogFailed
    ? "Danh mục sản phẩm hiện chưa tải được. Vui lòng thử lại sau."
    : state.products.length === 0
      ? "Hiện chưa có sản phẩm trong danh mục này."
      : "Không tìm thấy sản phẩm phù hợp. Hãy thay đổi từ khóa hoặc bộ lọc.";
  emptyState.hidden = products.length > 0;
  for (const product of products) {
    const card = document.createElement("article");
    card.className = "product-card";
    card.dataset.productSlug = product.slug;
    const visual = document.createElement("div");
    visual.className = "product-visual";
    const label = document.createElement("span");
    label.className = "product-label";
    label.textContent = product.stock > 0 ? "CÒN HÀNG" : "TẠM HẾT HÀNG";
    const image = document.createElement("img");
    image.src = productImage(product);
    image.alt = "Ảnh sản phẩm " + product.name;
    image.loading = "lazy";
    visual.append(label, image);

    const info = document.createElement("div");
    info.className = "product-info";
    const category = document.createElement("p");
    category.className = "product-category";
    category.textContent = product.categoryName || "Xiaomi Watch";
    const name = document.createElement("h3");
    name.className = "product-name";
    name.textContent = product.name;
    const description = document.createElement("p");
    description.className = "product-description";
    description.textContent = product.shortDescription;
    const specs = document.createElement("p");
    specs.className = "product-specs";
    specs.textContent = productSpecs(product);
    const bottom = document.createElement("div");
    bottom.className = "product-bottom";
    const priceStack = document.createElement("div");
    priceStack.className = "price-stack";
    const price = document.createElement("strong");
    price.className = "product-price";
    price.textContent = currency.format(Number(product.priceVnd));
    priceStack.append(price);
    if (product.compareAtVnd && Number(product.compareAtVnd) > Number(product.priceVnd)) {
      const oldPrice = document.createElement("span");
      oldPrice.className = "old-price";
      oldPrice.textContent = currency.format(Number(product.compareAtVnd));
      priceStack.append(oldPrice);
    }
    const add = document.createElement("button");
    add.className = "add-button";
    add.type = "button";
    add.textContent = "+";
    add.setAttribute("aria-label", "Thêm " + product.name + " vào giỏ");
    add.disabled = !product.stock;
    add.addEventListener("click", () => addToCart(product.id));
    bottom.append(priceStack, add);
    info.append(category, name, description, specs, bottom);
    card.append(visual, info);
    grid.append(card);
  }
}

function addToCart(id) {
  const product = state.products.find((item) => Number(item.id) === Number(id));
  if (!product) {
    showToast({ title: "Không tìm thấy sản phẩm.", icon: "error" });
    return;
  }

  const stock = Number(product.stock);
  if (!Number.isFinite(stock) || stock <= 0) {
    showToast({ title: "Sản phẩm hiện đã hết hàng.", icon: "warning" });
    return;
  }

  const item = state.cart.find((row) => row.id === Number(id));
  if (item && item.quantity >= stock) {
    showToast({
      title: "Đã đạt số lượng tối đa.",
      text: `${product.name} hiện chỉ còn ${stock} sản phẩm trong kho.`,
      icon: "warning",
    });
    return;
  }

  const quantity = item ? item.quantity + 1 : 1;
  if (item) item.quantity = quantity;
  else state.cart.push({ id: Number(id), quantity });
  saveCart();
  renderCart();
  showToast({
    title: "Đã thêm vào giỏ hàng.",
    text: `${product.name} · Số lượng trong giỏ: ${quantity}.`,
    icon: "success",
    timer: 2800,
  });
}

function changeQuantity(id, delta) {
  const item = state.cart.find((row) => row.id === Number(id));
  const product = state.products.find((row) => Number(row.id) === Number(id));
  if (!item || !product) return;
  item.quantity += delta;
  if (item.quantity <= 0) state.cart = state.cart.filter((row) => row.id !== Number(id));
  else item.quantity = Math.min(item.quantity, Number(product.stock));
  saveCart();
  renderCart();
}

function renderCart() {
  const container = $("#cart-items");
  container.replaceChildren();
  let quantity = 0;
  let total = 0;
  const rows = state.cart.flatMap((item) => {
    const product = state.products.find((row) => Number(row.id) === item.id);
    return product ? [{ item, product }] : [];
  });
  for (const { item, product } of rows) {
    quantity += item.quantity;
    total += Number(product.priceVnd) * item.quantity;
    const row = document.createElement("article");
    row.className = "cart-item";
    const image = document.createElement("img");
    image.src = productImage(product);
    image.alt = "";
    const info = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = product.name;
    const price = document.createElement("p");
    price.textContent = currency.format(Number(product.priceVnd));
    const controls = document.createElement("div");
    controls.className = "quantity-control";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", "Giảm số lượng");
    minus.addEventListener("click", () => changeQuantity(item.id, -1));
    const count = document.createElement("span");
    count.textContent = String(item.quantity);
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", "Tăng số lượng");
    plus.addEventListener("click", () => changeQuantity(item.id, 1));
    controls.append(minus, count, plus);
    info.append(name, price, controls);
    const remove = document.createElement("button");
    remove.className = "remove-item";
    remove.type = "button";
    remove.textContent = "Xóa";
    remove.addEventListener("click", () => {
      state.cart = state.cart.filter((cartItem) => cartItem.id !== item.id);
      saveCart();
      renderCart();
    });
    row.append(image, info, remove);
    container.append(row);
  }
  $("#cart-count").textContent = String(quantity);
  $("#drawer-count").textContent = String(quantity);
  $("#cart-total").textContent = currency.format(total);
  $("#cart-empty").hidden = rows.length > 0;
  $("#checkout-open").disabled = rows.length === 0;
}

function openDialog(dialog) {
  dialog.hidden = false;
  document.body.classList.add("modal-open");
}

function closeDialog(dialog) {
  dialog.hidden = true;
  if ($("#account-dialog").hidden && $("#checkout-dialog").hidden) document.body.classList.remove("modal-open");
}

function fillCheckoutFromProfile(overwrite = false) {
  if (!state.user) return;
  const fields = {
    shippingName: state.user.fullName,
    shippingPhone: state.user.phone,
    shippingAddress: state.user.address,
  };
  for (const [name, value] of Object.entries(fields)) {
    const input = $("#checkout-form").elements.namedItem(name);
    if (overwrite || !input.value.trim()) input.value = value || "";
  }
}

function openCart() {
  cartDrawer.classList.add("open");
  cartDrawer.setAttribute("aria-hidden", "false");
  scrim.hidden = false;
}

function closeCart() {
  cartDrawer.classList.remove("open");
  cartDrawer.setAttribute("aria-hidden", "true");
  scrim.hidden = true;
}

function setUser(user) {
  const previousUserId = state.user?.id;
  state.user = user;
  $("#account-label").textContent = user ? user.fullName : "Đăng nhập";
  $("#admin-return").hidden = user?.role !== "admin";
  $("#account-auth").hidden = Boolean(user);
  $("#account-dashboard").hidden = !user;
  if (user) {
    $("#profile-full-name").textContent = user.fullName || "—";
    $("#profile-username").textContent = user.username || "—";
    $("#profile-phone").textContent = user.phone || "Chưa cập nhật";
    $("#profile-email").textContent = user.email || "Chưa cập nhật";
    $("#profile-address").textContent = user.address || "Chưa cập nhật";
    showAccountView("orders");
    fillCheckoutFromProfile(previousUserId !== user.id);
  }
  else {
    document.querySelector('[data-auth-tab="login"]').click();
    $("#account-message").textContent = "";
    for (const field of ["shippingName", "shippingPhone", "shippingAddress"]) {
      $("#checkout-form").elements.namedItem(field).value = "";
    }
  }
}

function showAccountView(view) {
  document.querySelectorAll("[data-account-view]").forEach((button) => {
    const active = button.dataset.accountView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#account-orders").hidden = view !== "orders";
  $("#account-profile").hidden = view !== "profile";
}

async function loadUser() {
  try {
    const { user } = await api("/api/auth/me");
    setUser(user);
  } catch {
    setUser(null);
  }
}

async function loadProducts() {
  const notice = $("#service-notice");
  try {
    const { products } = await api("/api/products");
    state.products = products;
    state.catalogFailed = false;
    notice.hidden = true;
  } catch {
    state.products = [];
    state.catalogFailed = true;
    $("#service-notice-text").textContent = "Danh mục sản phẩm tạm thời chưa khả dụng.";
    notice.hidden = false;
  }
  renderCategories();
  renderProducts();
  renderCart();
}

function isUnpaidCryptoOrder(order) {
  return order.paymentMethod === "crypto" && ["unpaid", "failed"].includes(order.paymentStatus)
    && !["cancelled", "shipped", "delivered"].includes(order.orderStatus);
}

function cryptoPaymentStorageKey(orderId) {
  return `miwatch-crypto-tx-${orderId}`;
}

async function confirmCryptoPayment(orderId, txHash, signal) {
  const id = String(orderId);
  if (cryptoOrdersBeingConfirmed.has(id)) return false;
  cryptoOrdersBeingConfirmed.add(id);
  const storageKey = cryptoPaymentStorageKey(id);
  try {
    await api(`/api/orders/${id}/payments/crypto/confirm`, {
      method: "POST", body: JSON.stringify({ txHash }), signal,
    });
    if (localStorage.getItem(storageKey) === txHash) localStorage.removeItem(storageKey);
    return true;
  } catch (error) {
    if (error.code === "CRYPTO_TX_RETRYABLE" && localStorage.getItem(storageKey) === txHash) {
      localStorage.removeItem(storageKey);
    }
    throw error;
  } finally {
    cryptoOrdersBeingConfirmed.delete(id);
  }
}

async function recoverSubmittedCryptoPayments(orders) {
  const candidates = orders.filter(isUnpaidCryptoOrder);
  const results = await Promise.allSettled(candidates.map((order) => {
    if (state.cryptoPaymentOrderId === String(order.id)) return false;
    const txHash = localStorage.getItem(cryptoPaymentStorageKey(order.id));
    return txHash ? confirmCryptoPayment(order.id, txHash, AbortSignal.timeout(8000)) : false;
  }));
  return results.some((result) => result.status === "fulfilled" && result.value === true);
}

async function loadOrders({ recoverCryptoPayments = true } = {}) {
  const revision = ++ordersRevision;
  const target = $("#customer-orders");
  target.textContent = "Đang tải đơn hàng...";
  try {
    let { orders } = await api("/api/orders");
    if (revision !== ordersRevision) return;
    if (recoverCryptoPayments && await recoverSubmittedCryptoPayments(orders)) {
      ({ orders } = await api("/api/orders"));
    }
    if (revision !== ordersRevision) return;
    target.replaceChildren();
    if (!orders.length) {
      target.textContent = "Bạn chưa có đơn hàng.";
      return;
    }
    for (const order of orders) {
      const card = document.createElement("article");
      card.className = "customer-order-card";
      const title = document.createElement("strong");
      title.textContent = `${order.orderCode} · ${currency.format(Number(order.totalVnd))}`;
      const status = document.createElement("p");
      const paymentLabels = { unpaid: "chưa thanh toán", paid: "đã thanh toán", failed: "thanh toán lỗi", refunded: "đã hoàn tiền" };
      const methodLabel = order.paymentMethod === "vnpay" ? "VNPay"
        : order.paymentMethod === "crypto" ? "ETH qua MetaMask" : "Thanh toán khi nhận hàng";
      status.textContent = `Đơn: ${orderLabels[order.orderStatus] || order.orderStatus} · ${methodLabel} · ${paymentLabels[order.paymentStatus] || "chưa cập nhật"}`;
      card.append(title, status);
      if (order.statusHistory?.length) {
        const history = document.createElement("section");
        history.className = "customer-order-history";
        const heading = document.createElement("strong");
        heading.textContent = "Lịch sử trạng thái";
        const steps = document.createElement("ol");
        for (const entry of order.statusHistory) {
          const step = document.createElement("li");
          step.classList.toggle("is-current", entry.status === order.orderStatus);
          step.textContent = orderLabels[entry.status] || entry.status;
          steps.append(step);
        }
        history.append(heading, steps);
        card.append(history);
      }
      if (order.paymentMethod === "crypto" && order.cryptoAmountWei && window.ethers) {
        const quote = document.createElement("small");
        quote.className = "order-action-note";
        quote.textContent = `Số tiền: ${window.ethers.formatEther(order.cryptoAmountWei).replace(".", ",")} ETH`;
        card.append(quote);
      }
      const items = document.createElement("ul");
      items.className = "customer-order-items";
      for (const item of order.items ?? []) {
        const line = document.createElement("li");
        line.textContent = `${item.productName} · ${item.quantity} × ${currency.format(Number(item.unitPriceVnd))}`;
        items.append(line);
      }
      if (items.childElementCount) card.append(items);

      const actions = document.createElement("div");
      actions.className = "customer-order-actions";
      const vnpayPendingUntil = order.vnpayPendingUntil ? new Date(order.vnpayPendingUntil) : null;
      const vnpayAttemptActive = vnpayPendingUntil && vnpayPendingUntil.getTime() > Date.now();
      if (order.paymentMethod === "vnpay" && ["unpaid", "failed"].includes(order.paymentStatus)
          && order.orderStatus !== "cancelled" && !order.cancellationRequestedAt && !vnpayAttemptActive) {
        const retry = document.createElement("button");
        retry.className = "order-action-primary";
        retry.type = "button";
        retry.textContent = "Thanh toán lại";
        retry.addEventListener("click", () => retryVnpayPayment(order, retry));
        actions.append(retry);
      }
      if (order.paymentMethod === "vnpay" && vnpayAttemptActive && !order.cancellationRequestedAt) {
        const waiting = document.createElement("small");
        waiting.className = "order-action-note";
        waiting.textContent = `Phiên thanh toán đang mở đến ${vnpayPendingUntil.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}. Hoàn tất hoặc chờ phiên hết hạn để thanh toán lại.`;
        actions.append(waiting);
      }
      if (isUnpaidCryptoOrder(order) && !order.cancellationRequestedAt) {
        const retry = document.createElement("button");
        retry.className = "order-action-primary";
        retry.type = "button";
        const inProgress = state.cryptoPaymentOrderId === String(order.id);
        const savedTx = localStorage.getItem(cryptoPaymentStorageKey(order.id));
        retry.textContent = inProgress ? "Đang xử lý…" : savedTx ? "Kiểm tra lại giao dịch" : "Thử lại thanh toán ETH";
        retry.disabled = inProgress;
        retry.addEventListener("click", () => payCryptoOrder(order, retry));
        actions.append(retry);
      }
      if (order.cancellationRequestedAt) {
        const requestNote = document.createElement("small");
        requestNote.className = "order-action-note";
        requestNote.textContent = "Yêu cầu hủy đang chờ cửa hàng xử lý.";
        actions.append(requestNote);
      } else if (["pending", "confirmed", "packing"].includes(order.orderStatus)) {
        const cancel = document.createElement("button");
        cancel.className = "order-action-secondary";
        cancel.type = "button";
        cancel.textContent = "Yêu cầu hủy";
        cancel.addEventListener("click", () => requestCustomerCancellation(order, cancel));
        actions.append(cancel);
      } else if (order.orderStatus === "cancelled" && order.paymentStatus === "paid") {
        const cancellationNote = document.createElement("small");
        cancellationNote.className = "order-action-note";
        cancellationNote.textContent = "VNPay xác nhận thanh toán sau khi đơn đã hủy. Cửa hàng sẽ kiểm tra và hỗ trợ hoàn tiền.";
        actions.append(cancellationNote);
      }
      if (actions.childElementCount) card.append(actions);
      target.append(card);
    }
  } catch (error) {
    if (revision !== ordersRevision) return;
    target.textContent = vietnameseError(error, "Chưa tải được đơn hàng. Vui lòng thử lại.");
  }
}

async function retryVnpayPayment(order, button) {
  button.disabled = true;
  button.textContent = "Đang mở thanh toán…";
  try {
    const result = await api(`/api/orders/${order.id}/payments/vnpay/retry`, { method: "POST" });
    if (!result.paymentUrl) throw new Error("Chưa tạo được liên kết thanh toán. Vui lòng thử lại.");
    window.location.assign(result.paymentUrl);
  } catch (error) {
    button.disabled = false;
    button.textContent = "Thanh toán lại";
    const message = $("#account-message");
    message.classList.remove("success");
    message.textContent = vietnameseError(error, "Chưa mở được VNPay. Vui lòng thử lại.");
    showToast({ title: message.textContent, icon: "error", timer: 5200 });
  }
}

async function payCryptoOrder(order, button) {
  if (state.cryptoPaymentOrderId !== null || cryptoOrdersBeingConfirmed.has(String(order.id))) {
    showToast({ title: "Vui lòng hoàn tất yêu cầu thanh toán ETH đang mở." });
    return;
  }
  state.cryptoPaymentOrderId = String(order.id);
  if (button) {
    button.disabled = true;
    button.textContent = "Đang xử lý…";
  }
  const accountMessage = $("#account-message");
  accountMessage.classList.remove("success");
  const storageKey = cryptoPaymentStorageKey(order.id);
  try {
    let txHash = localStorage.getItem(storageKey);
    if (!txHash) {
      accountMessage.textContent = `Hãy xác nhận thanh toán đơn ${order.orderCode} trong MetaMask.`;
      const quote = await api(`/api/orders/${order.id}/payments/crypto/retry`, { method: "POST" });
      txHash = await submitCryptoPayment(quote, (submittedHash) => localStorage.setItem(storageKey, submittedHash));
    }
    accountMessage.textContent = "Đang xác minh giao dịch ETH…";
    await confirmCryptoPayment(order.id, txHash);
    accountMessage.textContent = "";
    showToast({ title: `Đã thanh toán đơn ${order.orderCode} bằng ETH.` });
  } catch (error) {
    if (error.code === "LOCAL_TX_REVERTED") localStorage.removeItem(storageKey);
    const message = vietnameseError(error, "Chưa hoàn tất thanh toán. Đơn vẫn được lưu để bạn thử lại.");
    accountMessage.textContent = localStorage.getItem(storageKey)
      ? `${message} Mã giao dịch đã được lưu trên trình duyệt để đồng bộ lại khi thử lần nữa.` : message;
    showToast({ title: message, icon: "error", timer: 6500 });
  } finally {
    state.cryptoPaymentOrderId = null;
  }
  await loadOrders({ recoverCryptoPayments: false });
}

async function requestCustomerCancellation(order, button) {
  const paidNote = order.paymentStatus === "paid" ? " Cửa hàng sẽ xử lý hoàn tiền trước khi duyệt hủy." : "";
  const confirmed = await confirmAction({
    title: "Gửi yêu cầu hủy đơn?",
    text: `Đơn ${order.orderCode}.${paidNote}`,
    confirmText: "Gửi yêu cầu",
  });
  if (!confirmed) return;
  button.disabled = true;
  try {
    await api(`/api/orders/${order.id}/cancellation-request`, { method: "POST" });
    const message = $("#account-message");
    message.classList.add("success");
    message.textContent = `Đã gửi yêu cầu hủy đơn ${order.orderCode}.`;
    showToast({ title: "Đã gửi yêu cầu hủy", text: `Đơn ${order.orderCode} đang chờ cửa hàng xử lý.` });
    await loadOrders();
  } catch (error) {
    button.disabled = false;
    const message = $("#account-message");
    message.classList.remove("success");
    message.textContent = vietnameseError(error, "Chưa gửi được yêu cầu hủy. Vui lòng thử lại.");
    showToast({ title: message.textContent, icon: "error", timer: 5200 });
  }
}

async function loadPaymentOptions() {
  const option = $("#vnpay-option");
  const note = $("#vnpay-availability");
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const status = await response.json();
    const configured = status.vnpaySandboxConfigured === true;
    option.disabled = !configured;
    if (status.cryptoEthVndRate) {
      const rate = new Intl.NumberFormat("vi-VN").format(Number(status.cryptoEthVndRate));
      $("#crypto-availability").textContent = `Tỷ giá quy đổi của cửa hàng: 1 ETH = ${rate} ₫.`;
    }
    note.textContent = configured ? "" : "VNPay hiện chưa khả dụng. Vui lòng chọn phương thức khác.";
  } catch {
    option.disabled = true;
    note.textContent = "VNPay hiện chưa khả dụng. Vui lòng chọn phương thức khác.";
  } finally {
    if (option.disabled && option.checked) $("input[name=paymentMethod][value=cod]").checked = true;
    updatePaymentNotes();
  }
}

function updatePaymentNotes() {
  const selected = $("input[name=paymentMethod]:checked")?.value;
  const vnpayNote = $("#vnpay-availability");
  const cryptoNote = $("#crypto-availability");
  vnpayNote.hidden = !vnpayNote.textContent;
  cryptoNote.hidden = selected !== "crypto" || !cryptoNote.textContent;
}

async function submitAuth(form, endpoint) {
  const message = $("#account-message");
  message.classList.remove("success");
  message.textContent = "";
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const { user } = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    setUser(user);
    if (endpoint === "/api/auth/login" && user.role === "admin") {
      window.location.assign("/admin.html");
      return;
    }
    form.reset();
    showAccountView("orders");
    await loadOrders();
  } catch (error) {
    message.classList.remove("success");
    message.textContent = vietnameseError(error, "Chưa đăng nhập được. Vui lòng thử lại.");
  }
}

$("#account-button").addEventListener("click", async () => {
  if (state.user) {
    openDialog(accountDialog);
    await loadOrders();
  } else {
    openDialog(accountDialog);
  }
});

$("#logout-button").addEventListener("click", async () => {
  if (!await confirmAction({
    title: "Đăng xuất khỏi tài khoản?",
    text: "Bạn có thể đăng nhập lại bất cứ lúc nào.",
    confirmText: "Đăng xuất",
  })) return;
  try {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    closeDialog(accountDialog);
    showToast({ title: "Bạn đã đăng xuất." });
  } catch (error) {
    $("#account-message").classList.remove("success");
    $("#account-message").textContent = vietnameseError(error, "Chưa đăng xuất được. Vui lòng thử lại.");
    showToast({ title: $("#account-message").textContent, icon: "error", timer: 5200 });
  }
});

$("#orders-refresh").addEventListener("click", loadOrders);

document.querySelectorAll("[data-account-view]").forEach((button) => {
  button.addEventListener("click", () => showAccountView(button.dataset.accountView));
});

document.querySelectorAll("[data-auth-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-auth-tab]").forEach((item) => item.classList.toggle("active", item === button));
    const register = button.dataset.authTab === "register";
    $("#login-form").hidden = register;
    $("#register-form").hidden = !register;
    $("#account-message").textContent = "";
  });
});

$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(event.currentTarget, "/api/auth/login");
});

$("#register-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(event.currentTarget, "/api/auth/register");
});

$("#search-input").addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  renderProducts();
});

$("#products-retry").addEventListener("click", loadProducts);

$("#sort-select").addEventListener("change", (event) => {
  state.sort = event.target.value;
  renderProducts();
});

document.querySelectorAll("[data-category-link]").forEach((link) => {
  link.addEventListener("click", () => {
    state.category = link.dataset.categoryLink;
    renderCategories();
    renderProducts();
  });
});

$("#cart-open").addEventListener("click", openCart);
$("#cart-close").addEventListener("click", closeCart);
scrim.addEventListener("click", closeCart);

$("#checkout-open").addEventListener("click", () => {
  closeCart();
  if (!state.user) {
    document.querySelector('[data-auth-tab="login"]').click();
    $("#account-message").textContent = "Đăng nhập hoặc tạo tài khoản để đặt hàng.";
    openDialog(accountDialog);
    return;
  }
  fillCheckoutFromProfile();
  openDialog(checkoutDialog);
});

document.querySelectorAll(".dialog-close").forEach((button) => {
  button.addEventListener("click", () => closeDialog(button.closest(".dialog")));
});

document.querySelectorAll(".dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
});

$("#checkout-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting === "true") return;
  const submitButton = form.querySelector('button[type="submit"]');
  form.dataset.submitting = "true";
  submitButton.disabled = true;
  submitButton.setAttribute("aria-busy", "true");
  const message = $("#checkout-message");
  message.textContent = "Đang tạo đơn hàng…";
  const formData = Object.fromEntries(new FormData(form).entries());
  if (state.user) {
    formData.shippingName ||= state.user.fullName;
    formData.shippingPhone ||= state.user.phone;
    formData.shippingAddress ||= state.user.address;
  }
  const body = {
    ...formData,
    items: state.cart.map((item) => ({ productId: item.id, quantity: item.quantity })),
  };
  try {
    const result = await api("/api/orders", { method: "POST", body: JSON.stringify(body) });
    state.cart = [];
    saveCart();
    renderCart();
    if (result.paymentUrl) {
      window.location.assign(result.paymentUrl);
      return;
    }
    if (result.order.paymentMethod === "crypto") {
      closeDialog(checkoutDialog);
      showAccountView("orders");
      openDialog(accountDialog);
      $("#customer-orders").textContent = `Đã tạo đơn ${result.order.orderCode}.`;
      await payCryptoOrder(result.order);
      return;
    }
    message.textContent = "";
    closeDialog(checkoutDialog);
    await showNotice({
      title: "Đặt hàng thành công",
      text: `Mã đơn ${result.order.orderCode}. Bạn có thể xem trạng thái trong tài khoản.`,
      confirmText: "Đóng",
    });
  } catch (error) {
    message.textContent = vietnameseError(error, "Chưa tạo được đơn hàng. Vui lòng thử lại.");
  } finally {
    form.dataset.submitting = "false";
    submitButton.disabled = false;
    submitButton.removeAttribute("aria-busy");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeCart();
    if (!accountDialog.hidden) closeDialog(accountDialog);
    if (!checkoutDialog.hidden) closeDialog(checkoutDialog);
  }
});

loadProducts();
loadUser();
window.addEventListener("pageshow", (event) => {
  if (event.persisted) loadUser();
});
loadPaymentOptions();
document.querySelectorAll('input[name="paymentMethod"]').forEach((input) => input.addEventListener("change", updatePaymentNotes));
updatePaymentNotes();

const query = new URLSearchParams(window.location.search);
const paymentResult = query.get("payment");
const pageNotice = query.get("notice");
if (paymentResult) {
  const labels = {
    success: "Thanh toán đã hoàn tất. Đơn hàng sẽ được cập nhật trong lịch sử.",
    late: "VNPay báo đã thanh toán nhưng đơn đã hủy. Cửa hàng sẽ kiểm tra và hỗ trợ hoàn tiền.",
    failed: "Thanh toán chưa hoàn tất. Bạn có thể thử lại trong mục Đơn hàng của tôi.",
    invalid: "Chưa xác minh được kết quả thanh toán. Hãy kiểm tra lịch sử đơn hàng.",
    error: "Chưa cập nhật được kết quả thanh toán. Hãy kiểm tra lịch sử đơn hàng hoặc thử thanh toán lại.",
  };
  if (labels[paymentResult]) {
    const success = paymentResult === "success";
    showToast({ title: labels[paymentResult], icon: success ? "success" : "warning", timer: 5200 });
  }
}
if (pageNotice === "logged-out") {
  showToast({ title: "Bạn đã đăng xuất." });
}
if (paymentResult || pageNotice) {
  window.history.replaceState({}, "", "/");
}

installVietnameseValidation();
