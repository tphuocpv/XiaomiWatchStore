const defaultTimer = 3600;

function library() {
  return window.Swal;
}

export async function confirmAction({
  title,
  text = "",
  confirmText = "Xác nhận",
  cancelText = "Quay lại",
  icon = "warning",
} = {}) {
  if (!library()?.fire) return window.confirm([title, text].filter(Boolean).join("\n\n"));
  const result = await library().fire({
    icon,
    title,
    text,
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: cancelText,
    reverseButtons: true,
    focusCancel: true,
    allowOutsideClick: false,
    buttonsStyling: false,
    customClass: {
      popup: "mitime-alert-popup",
      title: "mitime-alert-title",
      htmlContainer: "mitime-alert-text",
      confirmButton: "mitime-alert-confirm",
      cancelButton: "mitime-alert-cancel",
    },
  });
  return result.isConfirmed;
}

export function showToast({ title, text = "", icon = "success", timer = defaultTimer } = {}) {
  if (!library()?.fire) return Promise.resolve();
  return library().fire({
    toast: true,
    position: "top-end",
    icon,
    title,
    text,
    timer,
    timerProgressBar: true,
    showConfirmButton: false,
    customClass: { popup: "mitime-toast-popup" },
  });
}

export function showNotice({ title, text = "", confirmText = "Đóng", icon = "success" } = {}) {
  if (!library()?.fire) {
    window.alert([title, text].filter(Boolean).join("\n\n"));
    return Promise.resolve();
  }
  return library().fire({
    icon,
    title,
    text,
    confirmButtonText: confirmText,
    buttonsStyling: false,
    customClass: {
      popup: "mitime-alert-popup",
      title: "mitime-alert-title",
      htmlContainer: "mitime-alert-text",
      confirmButton: "mitime-alert-confirm",
    },
  });
}
