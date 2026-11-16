import { vietnameseError } from "./error-messages.js";

const hashPattern = /^0x[0-9a-f]{64}$/i;
const dateFormat = new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "long" });
const integerFormat = new Intl.NumberFormat("vi-VN");
const $ = (id) => document.getElementById(`transaction-${id}`);
const unavailable = "—";

function amount(value, unit) {
  return value == null ? unavailable : `${String(value).replace(".", ",")} ${unit}`;
}

function integer(value) {
  return value == null ? unavailable : integerFormat.format(BigInt(value));
}

function renderTransaction(transaction) {
  const content = {
    action: transaction.action || "Giao dịch blockchain",
    hash: transaction.hash,
    order: transaction.orderCode,
    invoice: transaction.invoiceHash,
    block: integer(transaction.blockNumber),
    time: transaction.timestamp ? dateFormat.format(new Date(transaction.timestamp)) : unavailable,
    chain: transaction.chainId,
    from: transaction.from,
    to: transaction.to || "—",
    value: amount(transaction.valueEth, "ETH"),
    fee: amount(transaction.feeEth, "ETH"),
    gas: integer(transaction.gasUsed),
    price: amount(transaction.gasPriceGwei, "Gwei"),
    nonce: integer(transaction.nonce),
  };
  for (const [field, value] of Object.entries(content)) $(field).textContent = value ?? unavailable;
  $("order-row").hidden = !transaction.orderCode;
  $("invoice-row").hidden = !transaction.invoiceHash;

  const statusLabels = { confirmed: "Đã xác nhận", failed: "Thất bại", pending: "Chờ xác nhận" };
  $("status").textContent = statusLabels[transaction.status] ?? "Chưa rõ trạng thái";
  $("status").dataset.status = transaction.status;

  const { movement } = transaction;
  if (movement) {
    $("movement-amount").textContent = amount(movement.amountEth, "ETH");
    $("movement-description").textContent = movement.description ?? "";
    $("movement-description").hidden = !movement.description;
    $("movement-from").textContent = movement.from ?? unavailable;
    $("movement-to").textContent = movement.to ?? unavailable;
  }
  $("movement").hidden = !movement;
  $("movement-note").hidden = !transaction.orderCode;

  const links = $("links");
  for (const { hash, label } of transaction.related ?? []) {
    if (typeof hash !== "string" || !hashPattern.test(hash) || hash.toLowerCase() === transaction.hash.toLowerCase()) continue;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/transaction.html?hash=${hash}`;
    link.textContent = label || "Xem giao dịch";
    const code = document.createElement("code");
    code.textContent = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
    link.append(code);
    item.append(link);
    links.append(item);
  }
  $("related").hidden = links.childElementCount === 0;
  $("result").hidden = false;
}

function showMessage(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
  $("message").hidden = !text;
}

function showInputError(message) {
  $("input-error").textContent = message;
  $("input-error").hidden = !message;
  if (message) $("query").setAttribute("aria-invalid", "true");
  else $("query").removeAttribute("aria-invalid");
}

async function loadTransaction(hash) {
  showMessage("Đang tra cứu giao dịch…");
  try {
    const response = await fetch(`/api/admin/blockchain/transactions/${hash}`, {
      credentials: "same-origin", cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) {
      showMessage("Hãy đăng nhập bằng tài khoản quản trị để xem chi tiết giao dịch.", true);
      $("login").hidden = false;
      return;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.transaction) {
      throw new Error(payload.error || "Chưa đọc được giao dịch. Vui lòng thử lại.");
    }
    renderTransaction(payload.transaction);
    showMessage("");
  } catch (error) {
    showMessage(vietnameseError(error, "Chưa đọc được giao dịch. Vui lòng thử lại."), true);
  }
}

const invalidHash = "Hãy nhập mã đầy đủ: 0x và 64 ký tự. Mã rút gọn có dấu … không dùng để tra cứu.";
$("search").addEventListener("submit", (event) => {
  const hash = $("query").value.trim();
  if (hashPattern.test(hash)) {
    $("query").value = hash.toLowerCase();
    return;
  }
  event.preventDefault();
  showInputError(invalidHash);
  $("query").focus();
});
$("query").addEventListener("input", () => showInputError(""));

$("copy").addEventListener("click", async () => {
  const hash = $("hash");
  try {
    await navigator.clipboard.writeText(hash.textContent);
    $("copy").textContent = "Đã sao chép";
    $("copy-status").textContent = "Đã sao chép mã giao dịch.";
  } catch {
    const selection = window.getSelection();
    if (selection) {
      selection.selectAllChildren(hash);
      $("copy-status").textContent = "Đã chọn mã giao dịch để bạn sao chép.";
    }
  }
});

const initialHash = new URLSearchParams(window.location.search).get("hash")?.trim();
if (initialHash) {
  $("query").value = initialHash;
  if (hashPattern.test(initialHash)) loadTransaction(initialHash.toLowerCase());
  else showInputError(invalidHash);
}
