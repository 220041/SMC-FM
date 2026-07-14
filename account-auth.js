import {
  auth, db, doc, getDoc, setDoc, serverTimestamp,
  signInWithEmailAndPassword, updatePassword, sendPasswordResetEmail, signOut,
  USER_ACCOUNTS, INITIAL_PASSWORD
} from "./firebase-config.js";

function accountByEmail(email) {
  return Object.entries(USER_ACCOUNTS).find(([, value]) => value.email.toLowerCase() === String(email || "").toLowerCase());
}

function addStyles() {
  if (document.getElementById("account-auth-style")) return;
  const style = document.createElement("style");
  style.id = "account-auth-style";
  style.textContent = `.account-overlay{position:fixed;inset:0;z-index:12000;background:#1f2933;display:flex;align-items:center;justify-content:center;padding:18px}.account-card{width:min(420px,100%);background:#fff;border-radius:18px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.4)}.account-card h2{margin:0 0 6px;font-size:22px}.account-card p{margin:0 0 20px;color:#5a6572;font-size:14px}.account-card label{display:block;margin:12px 0 6px;font-weight:700;font-size:13px}.account-card select,.account-card input{width:100%;padding:12px;border:1.5px solid #c7cdd3;border-radius:10px;font-size:16px}.account-card button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;background:#2b4c7e;color:#fff;font-weight:800;font-size:15px;cursor:pointer}.account-card .secondary{background:#eef0f1;color:#1f2933}.account-error{color:#c23b3b;margin-top:10px;font-size:13px;min-height:18px}`;
  document.head.appendChild(style);
}

function profileForUser(user) {
  const found = accountByEmail(user && user.email);
  if (!found) return null;
  const [loginId, account] = found;
  return { uid: user.uid, loginId, name: loginId === "admin" ? "관리자" : loginId, email: account.email, role: account.role };
}

async function persistProfile(profile) {
  const ref = doc(db, "users", profile.uid);
  const snap = await getDoc(ref);
  const data = { loginId: profile.loginId, name: profile.name, email: profile.email, active: true, updatedAt: serverTimestamp() };
  if (!snap.exists()) data.role = "member"; // admin 역할은 Console에서 한 번 지정
  await setDoc(ref, data, { merge: true });
}

async function forceInitialPasswordChange(user) {
  const overlay = document.createElement("div");
  overlay.className = "account-overlay";
  overlay.innerHTML = `<div class="account-card"><h2>비밀번호 변경</h2><p>초기 비밀번호를 새 비밀번호로 변경해야 합니다.</p><label>새 비밀번호</label><input id="force-new-pw" type="password" minlength="6"><label>새 비밀번호 확인</label><input id="force-new-pw2" type="password" minlength="6"><button id="force-pw-save">변경</button><div class="account-error" id="force-pw-error"></div></div>`;
  document.body.appendChild(overlay);
  return new Promise(resolve => {
    overlay.querySelector("#force-pw-save").onclick = async () => {
      const p1 = overlay.querySelector("#force-new-pw").value;
      const p2 = overlay.querySelector("#force-new-pw2").value;
      const err = overlay.querySelector("#force-pw-error");
      if (p1.length < 6 || p1 === INITIAL_PASSWORD) { err.textContent = "초기 비밀번호와 다른 6자리 이상의 비밀번호를 사용하세요."; return; }
      if (p1 !== p2) { err.textContent = "비밀번호가 서로 다릅니다."; return; }
      try { await updatePassword(user, p1); overlay.remove(); resolve(); }
      catch (e) { err.textContent = "변경하지 못했습니다. 다시 로그인해 주세요."; }
    };
  });
}

export async function ensureUserLogin({ adminOnly = false } = {}) {
  addStyles();
  let profile = profileForUser(auth.currentUser);
  if (profile && (!adminOnly || profile.role === "admin")) { await persistProfile(profile); return profile; }
  if (auth.currentUser) await signOut(auth);
  const overlay = document.createElement("div");
  overlay.className = "account-overlay";
  const choices = Object.entries(USER_ACCOUNTS).filter(([, a]) => !adminOnly || a.role === "admin").map(([id]) => `<option value="${id}">${id === "admin" ? "관리자" : id}</option>`).join("");
  overlay.innerHTML = `<div class="account-card"><h2>${adminOnly ? "관리자 로그인" : "사용자 로그인"}</h2><p>본인 계정과 비밀번호를 입력하세요.</p><label>아이디</label><select id="account-id">${choices}</select><label>비밀번호</label><input id="account-pw" type="password"><button id="account-login">로그인</button><button class="secondary" id="account-reset">비밀번호 재설정 메일</button><div class="account-error" id="account-error"></div></div>`;
  document.body.appendChild(overlay);
  return new Promise(resolve => {
    const submit = async () => {
      const id = overlay.querySelector("#account-id").value;
      const password = overlay.querySelector("#account-pw").value;
      const err = overlay.querySelector("#account-error");
      try {
        const credential = await signInWithEmailAndPassword(auth, USER_ACCOUNTS[id].email, password);
        const p = profileForUser(credential.user);
        if (adminOnly && p.role !== "admin") throw new Error("admin-required");
        await persistProfile(p); overlay.remove();
        if (password === INITIAL_PASSWORD) await forceInitialPasswordChange(credential.user);
        resolve(p);
      } catch (e) { err.textContent = "아이디 또는 비밀번호를 확인하세요."; }
    };
    overlay.querySelector("#account-login").onclick = submit;
    overlay.querySelector("#account-pw").onkeydown = e => { if (e.key === "Enter") submit(); };
    overlay.querySelector("#account-reset").onclick = async () => {
      const account = USER_ACCOUNTS[overlay.querySelector("#account-id").value];
      const err = overlay.querySelector("#account-error");
      try { await sendPasswordResetEmail(auth, account.email); err.style.color = "#1f7a5c"; err.textContent = `${account.email}로 재설정 메일을 보냈습니다.`; }
      catch (e) { err.textContent = "재설정 메일을 보내지 못했습니다."; }
    };
  });
}

export async function logoutAccount() { await signOut(auth); location.reload(); }
export async function changeOwnPassword() {
  const next = prompt("새 비밀번호를 입력하세요 (6자리 이상)");
  if (next === null) return false;
  if (next.length < 6 || next === INITIAL_PASSWORD) { alert("초기 비밀번호와 다른 6자리 이상의 비밀번호를 입력하세요."); return false; }
  await updatePassword(auth.currentUser, next); alert("비밀번호가 변경되었습니다."); return true;
}
export async function sendResetForLoginId(loginId) {
  const account = USER_ACCOUNTS[loginId];
  if (!account) throw new Error("unknown-account");
  await sendPasswordResetEmail(auth, account.email);
}
