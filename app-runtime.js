/* 공통 실행 상태 UI: 네트워크 단절과 저장/구독 오류를 화면에서 확인할 수 있게 한다. */
let installed = false;

function ensureRuntimeUi() {
  if (installed) return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = `
    #app-connection-status{position:fixed;right:12px;bottom:12px;z-index:15000;padding:7px 11px;border-radius:999px;background:#fff3cd;color:#856404;border:1px solid #efd887;font:700 12px/1.2 sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.12);display:none}
    #app-connection-status.offline{display:block}
    #app-toast{position:fixed;left:50%;bottom:18px;z-index:15001;transform:translate(-50%,14px);max-width:min(520px,calc(100vw - 32px));padding:10px 16px;border-radius:10px;background:#1f2933;color:#fff;font:700 13px/1.45 sans-serif;box-shadow:0 5px 20px rgba(0,0,0,.24);opacity:0;pointer-events:none;transition:.2s}
    #app-toast.show{opacity:1;transform:translate(-50%,0)}
    #app-toast.error{background:#9f2f2f}
  `;
  document.head.appendChild(style);
  const status = document.createElement("div");
  status.id = "app-connection-status";
  status.setAttribute("role", "status");
  status.textContent = "오프라인 · 연결되면 자동으로 다시 시도합니다";
  const toast = document.createElement("div");
  toast.id = "app-toast";
  toast.setAttribute("role", "status");
  document.body.append(status, toast);
}

export function installConnectionStatus() {
  ensureRuntimeUi();
  const render = () => document.getElementById("app-connection-status")?.classList.toggle("offline", !navigator.onLine);
  window.addEventListener("online", () => { render(); showToast("네트워크가 다시 연결되었습니다"); });
  window.addEventListener("offline", render);
  window.addEventListener("unhandledrejection", event => {
    console.error("처리되지 않은 비동기 오류", event.reason);
    showToast("작업을 완료하지 못했습니다. 입력 내용과 연결 상태를 확인해 주세요.", { error:true, duration:5000 });
  });
  render();
}

let toastTimer = null;
export function showToast(message, { error = false, duration = 2800 } = {}) {
  ensureRuntimeUi();
  const toast = document.getElementById("app-toast");
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

export function reportDataError(context, error) {
  console.error(`${context} 오류`, error);
  showToast(`${context}에 실패했습니다. 연결과 권한을 확인해 주세요.`, { error: true, duration: 5000 });
}

export async function withBusyButton(button, busyText, job) {
  if (!button || button.disabled) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try { return await job(); }
  finally { button.disabled = false; button.textContent = original; }
}
