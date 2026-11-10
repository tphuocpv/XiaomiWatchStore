import { installVietnameseValidation, vietnameseError } from "./error-messages.js";

const state = {
  products: [],
  catalogFailed: false,
  category: "all",
  search: "",
  sort: "featured",
  cart: readCart(),
  user: null,
};

const $ = (selector) => document.querySelector(selector);
const grid = $("#product-grid");
const cartDrawer = $("#cart-drawer");
const scrim = $("#scrim");
const accountDialog = $("#account-dialog");
const checkoutDialog = $("#checkout-dialog");
const currency = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const orderLabels = { pending: "Chờ xử lý", confirmed: "Đã xác nhận", packing: "Đang đóng gói", shipped: "Đang giao", delivered: "Đã giao", cancelled: "Đã hủy" };

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
  if (!response.ok) throw new Error(data.error || "Yêu cầu chưa hoàn tất.");
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
  if (!product || !product.stock) return;
  const item = state.cart.find((row) => row.id === Number(id));
  if (item) item.quantity = Math.min(item.quantity + 1, Number(product.stock));
  else state.cart.push({ id: Number(id), quantity: 1 });
  saveCart();
  renderCart();
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

async function loadOrders() {
  const target = $("#customer-orders");
  target.textContent = "Đang tải đơn hàng...";
  try {
    const { orders } = await api("/api/orders");
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
      const methodLabel = order.paymentMethod === "vnpay" ? "VNPay" : "Thanh toán khi nhận hàng";
      status.textContent = `Đơn: ${orderLabels[order.orderStatus] || order.orderStatus} · ${methodLabel} · ${paymentLabels[order.paymentStatus] || "chưa cập nhật"}`;
      card.append(title, status);
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
      if (order.paymentMethod === "vnpay" && ["unpaid", "failed"].includes(order.paymentStatus)
          && order.orderStatus !== "cancelled" && !order.cancellationRequestedAt) {
        const retry = document.createElement("button");
        retry.className = "order-action-primary";
        retry.type = "button";
        retry.textContent = "Thanh toán lại";
        retry.addEventListener("click", () => retryVnpayPayment(order, retry));
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
        cancellationNote.textContent = "Đơn đã hủy nhưng giao dịch được xác nhận sau đó. Vui lòng liên hệ cửa hàng để được hỗ trợ.";
        actions.append(cancellationNote);
      }
      if (actions.childElementCount) card.append(actions);
      target.append(card);
    }
  } catch (error) {
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
  }
}

async function requestCustomerCancellation(order, button) {
  const paidNote = order.paymentStatus === "paid" ? " Cửa hàng sẽ xử lý hoàn tiền trước khi duyệt hủy." : "";
  if (!window.confirm(`Gửi yêu cầu hủy đơn ${order.orderCode}?${paidNote}`)) return;
  button.disabled = true;
  try {
    await api(`/api/orders/${order.id}/cancellation-request`, { method: "POST" });
    const message = $("#account-message");
    message.classList.add("success");
    message.textContent = `Đã gửi yêu cầu hủy đơn ${order.orderCode}.`;
    await loadOrders();
  } catch (error) {
    button.disabled = false;
    const message = $("#account-message");
    message.classList.remove("success");
    message.textContent = vietnameseError(error, "Chưa gửi được yêu cầu hủy. Vui lòng thử lại.");
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
    if (!configured && option.checked) $("input[name=paymentMethod][value=cod]").checked = true;
    note.textContent = configured
      ? "Giao dịch được xử lý trong môi trường thử nghiệm, không phát sinh khoản thu thực."
      : "Thanh toán VNPay hiện chưa khả dụng. Bạn có thể chọn thanh toán khi nhận hàng.";
  } catch {
    option.disabled = true;
    note.textContent = "Không thể kiểm tra VNPay lúc này. Vui lòng chọn thanh toán khi nhận hàng.";
  }
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
  try {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
    closeDialog(accountDialog);
  } catch (error) {
    $("#account-message").classList.remove("success");
    $("#account-message").textContent = vietnameseError(error, "Chưa đăng xuất được. Vui lòng thử lại.");
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
    message.textContent = "";
    closeDialog(checkoutDialog);
    window.alert("Đã tạo đơn " + result.order.orderCode + ". Bạn có thể xem trạng thái trong tài khoản.");
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
loadPaymentOptions();

const paymentResult = new URLSearchParams(window.location.search).get("payment");
if (paymentResult) {
  const labels = {
    success: "Thanh toán đã hoàn tất. Đơn hàng sẽ được cập nhật trong lịch sử.",
    failed: "Thanh toán chưa hoàn tất. Bạn có thể thử lại trong mục Đơn hàng của tôi.",
    invalid: "Chưa xác minh được kết quả thanh toán. Hãy kiểm tra lịch sử đơn hàng.",
    error: "Chưa cập nhật được kết quả thanh toán. Hãy kiểm tra lịch sử đơn hàng hoặc thử thanh toán lại.",
  };
  if (labels[paymentResult]) window.setTimeout(() => window.alert(labels[paymentResult]), 100);
  window.history.replaceState({}, "", "/");
}

installVietnameseValidation();
