import "./toast.css";

const HOST_ID = "justwork-toast-host";

export type ToastVariant = "error" | "warning" | "success" | "info";

export type ShowToastOptions = {
  message: string;
  variant?: ToastVariant;
  /** 默认约 4s；错误类略长可在调用处指定 */
  durationMs?: number;
};

function ensureHost(): HTMLElement {
  let el = document.getElementById(HOST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = HOST_ID;
    el.className = "justwork-toast-host";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

/**
 * 全局 Toast：固定在视口上方居中，自动堆叠；无需在 HTML 中预留节点。
 * 扩展内各页面均可直接调用。
 */
export function showToast(opts: ShowToastOptions): void {
  const message = opts.message.trim();
  if (!message) return;

  const variant = opts.variant ?? "info";
  const durationMs = opts.durationMs ?? (variant === "error" ? 5200 : 4200);

  const host = ensureHost();
  const item = document.createElement("div");
  item.className = `justwork-toast justwork-toast--${variant}`;
  item.setAttribute("role", variant === "error" ? "alert" : "status");
  item.textContent = message;
  host.appendChild(item);

  requestAnimationFrame(() => {
    item.classList.add("justwork-toast--visible");
  });

  window.setTimeout(() => {
    item.classList.remove("justwork-toast--visible");
    window.setTimeout(() => item.remove(), 280);
  }, durationMs);
}
