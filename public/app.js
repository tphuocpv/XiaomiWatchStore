const demoProducts = [
  { id: 1, name: "Xiaomi Watch S4", slug: "xiaomi-watch-s4", shortDescription: "Màn hình AMOLED · GPS · Thời lượng pin dài", priceVnd: 3990000, compareAtVnd: 4490000, stock: 12, imageUrl: "/assets/watch-s4.svg", categoryName: "Đồng hồ Xiaomi", categorySlug: "dong-ho-xiaomi", specifications: { display: "AMOLED", gps: "Tích hợp", battery: "Thông số minh họa" } },
  { id: 2, name: "Xiaomi Watch 2", slug: "xiaomi-watch-2", shortDescription: "Thiết kế thể thao · Theo dõi vận động", priceVnd: 4490000, compareAtVnd: 4990000, stock: 8, imageUrl: "/assets/watch-2.svg", categoryName: "Đồng hồ Xiaomi", categorySlug: "dong-ho-xiaomi", specifications: { display: "AMOLED", gps: "Tích hợp", battery: "Thông số minh họa" } },
  { id: 3, name: "Redmi Watch 5", slug: "redmi-watch-5", shortDescription: "Màn hình lớn · Nhiều chế độ luyện tập", priceVnd: 1790000, compareAtVnd: 1990000, stock: 20, imageUrl: "/assets/redmi-watch-5.svg", categoryName: "Đồng hồ Redmi", categorySlug: "dong-ho-redmi", specifications: { display: "AMOLED", gps: "Tùy phiên bản", battery: "Thông số minh họa" } },
  { id: 4, name: "Xiaomi Smart Band 9 Pro", slug: "xiaomi-smart-band-9-pro", shortDescription: "Nhẹ gọn · Theo dõi sức khỏe hằng ngày", priceVnd: 1590000, compareAtVnd: 1890000, stock: 18, imageUrl: "/assets/smart-band-9-pro.svg", categoryName: "Vòng đeo thông minh", categorySlug: "vong-deo-thong-minh", specifications: { display: "AMOLED", gps: "Tích hợp", battery: "Thông số minh họa" } },
];

const state = {
  products: [],
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
  $("#empty-products").hidden = products.length > 0;
  for (const product of products) {
    const card = document.createElement("article");
    card.className = "product-card";
    const visual = document.createElement("div");
    visual.className = "product-visual";
    const label = document.createElement("span");
    label.className = "product-label";
    label.textContent = product.stock > 0 ? "ĐANG ĐƯỢC QUAN TÂM" : "TẠM HẾT HÀNG";
    const favorite = document.createElement("button");
    favorite.className = "favorite-button";
    favorite.type = "button";
    favorite.setAttribute("aria-label", "Đánh dấu yêu thích");
    favorite.textContent = "♡";
    const image = document.createElement("img");
    image.src = productImage(product);
    image.alt = "Đồng hồ " + product.name;
    image.loading = "lazy";
    visual.append(label, favorite, image);

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
  state.user = user;
  $("#account-label").textContent = user ? user.fullName : "Đăng nhập";
  $("#account-orders").hidden = !user;
  $("#login-form").hidden = Boolean(user);
  if (user) $("#register-form").hidden = true;
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
  try {
    const { products } = await api("/api/products");
    state.products = products;
    $("#service-notice").hidden = true;
  } catch {
    state.products = demoProducts;
    $("#service-notice").textContent = "Đang hiển thị sản phẩm minh họa. Hãy bật MySQL và nhập các tệp schema/seed để tải dữ liệu thật từ cơ sở dữ liệu.";
    $("#service-notice").hidden = false;
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
      status.textContent = `Đơn: ${orderLabels[order.orderStatus] || order.orderStatus} · Thanh toán: ${order.paymentStatus === "paid" ? "đã thanh toán" : order.paymentStatus === "failed" ? "thất bại" : "chưa thanh toán"}`;
      card.append(title, status);
      if (order.blockchainTxHash) {
        const proof = document.createElement("small");
        proof.textContent = `Đã ghi nhận trên LabChain Local · ${order.blockchainTxHash.slice(0, 14)}…`;
        card.append(proof);
      } else {
        const proof = document.createElement("small");
        proof.textContent = "Đơn đang chờ admin ghi dấu lên blockchain local.";
        card.append(proof);
      }
      target.append(card);
    }
  } catch (error) {
    target.textContent = error.message;
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
      ? "Sandbox đã sẵn sàng; đây là giao dịch mô phỏng, không thu tiền thật."
      : "VNPay sandbox sẽ bật sau khi cấu hình TmnCode và HashSecret trong .env.";
  } catch {
    option.disabled = true;
    note.textContent = "Chưa kết nối được máy chủ để kiểm tra VNPay sandbox.";
  }
}

async function submitAuth(form, endpoint) {
  const message = $("#account-message");
  message.textContent = "";
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    const { user } = await api(endpoint, { method: "POST", body: JSON.stringify(body) });
    setUser(user);
    closeDialog(accountDialog);
    form.reset();
  } catch (error) {
    message.textContent = error.message;
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
    $("#account-message").textContent = error.message;
  }
});

$("#orders-refresh").addEventListener("click", loadOrders);

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
  const message = $("#checkout-message");
  message.textContent = "";
  const formData = Object.fromEntries(new FormData(event.currentTarget).entries());
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
    if (result.paymentUrl) {
      window.location.assign(result.paymentUrl);
      return;
    }
    state.cart = [];
    saveCart();
    renderCart();
    closeDialog(checkoutDialog);
    window.alert("Đã tạo đơn " + result.order.orderCode + ". Bạn có thể xem trạng thái trong tài khoản.");
  } catch (error) {
    message.textContent = error.message;
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
    success: "Thanh toán VNPay sandbox thành công.",
    failed: "VNPay sandbox không hoàn tất thanh toán; đơn đã được hủy.",
    invalid: "Không xác minh được kết quả VNPay. Hãy kiểm tra lại đơn hàng.",
    error: "Chưa cập nhật được kết quả VNPay. Hãy mở lịch sử đơn hàng để kiểm tra.",
  };
  if (labels[paymentResult]) window.setTimeout(() => window.alert(labels[paymentResult]), 100);
  window.history.replaceState({}, "", "/");
}
