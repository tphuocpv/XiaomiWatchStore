const vietnameseFallback = "Đã xảy ra lỗi. Vui lòng thử lại.";

export function vietnameseError(error, fallback = vietnameseFallback) {
  const message = typeof error === "string" ? error : String(error?.shortMessage || error?.message || "");
  if (!message) return fallback;
  if (/[À-ỹ]/u.test(message)) return message;
  if (/user rejected|user denied|rejected the request|action_rejected|code\s*4001/i.test(message)) {
    return "Bạn đã từ chối yêu cầu trong MetaMask.";
  }
  if (/insufficient funds|not enough funds|funds for gas/i.test(message)) {
    return "Ví không đủ ETH thử nghiệm để trả phí giao dịch.";
  }
  if (/could not coalesce|internal json-rpc error|unknown rpc error/i.test(message)) {
    return "MetaMask hoặc mạng blockchain cục bộ chưa xử lý được yêu cầu. Hãy kiểm tra mạng LabChain Local.";
  }
  if (/failed to fetch|networkerror|network request failed|load failed|econnrefused|connection refused|err_connection/i.test(message)) {
    return "Không kết nối được máy chủ. Hãy kiểm tra máy chủ web và MySQL rồi thử lại.";
  }
  if (/timeout|timed out|request took too long/i.test(message)) {
    return "Yêu cầu mất quá nhiều thời gian. Vui lòng thử lại.";
  }
  if (/cannot (get|post|put|patch|delete)|not found|404/i.test(message)) {
    return "Không tìm thấy trang hoặc chức năng này. Hãy kiểm tra lại đường dẫn.";
  }
  if (/invalid email|email.*valid/i.test(message)) return "Vui lòng nhập địa chỉ email hợp lệ.";
  return fallback;
}

function validationMessage(field) {
  const validity = field.validity;
  if (validity.valueMissing) return "Vui lòng điền thông tin này.";
  if (validity.typeMismatch && field.type === "email") return "Vui lòng nhập địa chỉ email hợp lệ.";
  if (validity.tooShort) return `Vui lòng nhập ít nhất ${field.minLength} ký tự.`;
  if (validity.tooLong) return `Vui lòng nhập không quá ${field.maxLength} ký tự.`;
  if (validity.rangeUnderflow) return `Giá trị nhỏ nhất là ${field.min}.`;
  if (validity.rangeOverflow) return `Giá trị lớn nhất là ${field.max}.`;
  if (validity.stepMismatch || validity.badInput) return "Vui lòng nhập một giá trị hợp lệ.";
  if (validity.patternMismatch) return "Thông tin chưa đúng định dạng.";
  return "Vui lòng kiểm tra lại thông tin vừa nhập.";
}

export function installVietnameseValidation(root = document) {
  root.addEventListener("invalid", (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return;
    field.setCustomValidity(validationMessage(field));
  }, true);
  const clearMessage = (event) => {
    const field = event.target;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) {
      field.setCustomValidity("");
    }
  };
  root.addEventListener("input", clearMessage, true);
  root.addEventListener("change", clearMessage, true);
}
