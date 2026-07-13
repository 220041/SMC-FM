// 접근코드 입력 게이트 + Firebase 익명 인증
// 코드가 맞으면 세션 동안(sessionStorage) 다시 묻지 않음.

import { auth, signInAnonymously, onAuthStateChanged, ACCESS_CODE } from "./firebase-config.js";

const SESSION_KEY = "smcfm_gate_ok";

function buildGateOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "gate-overlay";
  overlay.innerHTML = `
    <div class="gate-card">
      <div class="gate-title">서귀포의료원 시설관리팀</div>
      <div class="gate-sub">접근코드를 입력하세요</div>
      <input id="gate-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" />
      <button id="gate-submit">입장</button>
      <div id="gate-error">코드가 올바르지 않습니다</div>
    </div>
  `;
  const style = document.createElement("style");
  style.textContent = `
    #gate-overlay {
      position: fixed; inset: 0; z-index: 9999;
      background: #1F2933;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Pretendard', -apple-system, 'Malgun Gothic', sans-serif;
    }
    .gate-card {
      background: #F5F6F4; border-radius: 20px;
      padding: 48px 56px; text-align: center;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      min-width: 340px;
    }
    .gate-title { font-size: 22px; font-weight: 800; color: #1F2933; margin-bottom: 6px; }
    .gate-sub { font-size: 16px; color: #5A6572; margin-bottom: 24px; }
    #gate-input {
      width: 100%; box-sizing: border-box;
      font-size: 28px; letter-spacing: 12px; text-align: center;
      padding: 14px 10px; border: 2px solid #C7CDD3; border-radius: 12px;
      margin-bottom: 16px; outline: none;
    }
    #gate-input:focus { border-color: #2B4C7E; }
    #gate-submit {
      width: 100%; padding: 14px; font-size: 18px; font-weight: 700;
      background: #2B4C7E; color: #fff; border: none; border-radius: 12px;
      cursor: pointer;
    }
    #gate-submit:active { background: #223d66; }
    #gate-error { display: none; color: #C23B3B; font-size: 14px; margin-top: 12px; font-weight: 600; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#gate-input");
  const btn = overlay.querySelector("#gate-submit");
  const err = overlay.querySelector("#gate-error");

  return new Promise((resolve) => {
    function trySubmit() {
      if (input.value === ACCESS_CODE) {
        sessionStorage.setItem(SESSION_KEY, "1");
        overlay.remove();
        resolve();
      } else {
        err.style.display = "block";
        input.value = "";
        input.focus();
      }
    }
    btn.addEventListener("click", trySubmit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") trySubmit(); });
    setTimeout(() => input.focus(), 100);
  });
}

// ensureAccess(): 접근코드 확인 + Firebase 익명 인증 완료까지 기다린 뒤 resolve
export async function ensureAccess() {
  // 1. Firebase 인증 상태 확인 (비동기 완료 대기)
  const authReady = new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
  let user = await authReady;

  // 2. 접근코드 확인 (세션에 없으면 화면 표시)
  if (sessionStorage.getItem(SESSION_KEY) !== "1") {
    await buildGateOverlay();
  }

  // 3. 아직 로그인 안 되어 있으면 익명 로그인
  if (!user) {
    await signInAnonymously(auth);
  }
}
