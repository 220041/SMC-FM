import { ensureUserLogin, logoutAccount, changeOwnPassword } from "./account-auth.js";
import { installConnectionStatus, showToast, reportDataError } from "./app-runtime.js";
import { SCHEMA_VERSION, monthKeysForDates, archiveFields, isRecordOwner } from "./data-model.js";
import {
  db, auth, collection, doc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp,
  getDocs, getDoc, limit, where, writeBatch, TEAM_MEMBERS, KR_HOLIDAYS
} from "./firebase-config.js";

const accountProfile = await ensureUserLogin();
installConnectionStatus();

/* 작성자·알림 대상·권한 판정은 Firebase에 로그인한 계정으로 고정한다. */
const currentUserName = accountProfile.name;
function currentUser() { return currentUserName; }
function currentUid() { return accountProfile.uid; }
function isAdmin() { return accountProfile.role === "admin"; }
const memberUidByName = new Map([[currentUser(), currentUid()]]);
try {
  const memberProfiles = await getDocs(collection(db, "users"));
  memberProfiles.docs.forEach(item => { const data = item.data(); if (data.name) memberUidByName.set(data.name, item.id); });
} catch (error) {
  console.warn("사용자 UID 목록을 불러오지 못해 기존 이름 경로를 사용합니다.", error);
}
function notificationOwnerKey(name) { return memberUidByName.get(name) || name; }

document.getElementById("author-change-btn").addEventListener("click", logoutAccount);
const passwordBtn = document.createElement("button");
passwordBtn.type = "button";
passwordBtn.className = "icon-btn";
passwordBtn.textContent = "🔑";
passwordBtn.title = "비밀번호 변경";
passwordBtn.setAttribute("aria-label", "비밀번호 변경");
passwordBtn.style.cssText = "width:20px;height:20px;padding:0;margin-left:3px;border:0;background:transparent;box-shadow:none;border-radius:0;font-size:11px;vertical-align:middle;";
passwordBtn.addEventListener("click", changeOwnPassword);
document.getElementById("author-change-btn").insertAdjacentElement("beforebegin", passwordBtn);
document.getElementById("current-user-display").textContent = accountProfile.name;

/* 관리자 화면(admin.html)에서 등록한 임시 공휴일 등 (기본 KR_HOLIDAYS에 없는 날짜를 추가로 반영) */
let customHolidays = {};
function holidayName(iso) { return customHolidays[iso] || KR_HOLIDAYS[iso]; }
onSnapshot(collection(db, "customHolidays"), (snap) => {
  const map = {};
  snap.docs.forEach(d => { map[d.id] = (d.data() && d.data().name) || "공휴일"; });
  customHolidays = map;
  if (dpPopup.classList.contains("open")) dpRenderCalendar();
  if (document.getElementById("schedule-calendar-view").style.display !== "none") renderScheduleCalendar();
}, error => reportDataError("공휴일 불러오기", error));

/* 담당자 등 이름 select 채우기 helper */
function fillNameSelect(sel, defaultTo) {
  sel.innerHTML = "";
  TEAM_MEMBERS.forEach(n => sel.appendChild(new Option(n, n)));
  if (defaultTo) sel.value = defaultTo;
}
/* 담당자(업무) select: "미지정" 옵션 포함 */
function fillAssigneeSelect(sel, defaultTo) {
  sel.innerHTML = "";
  sel.appendChild(new Option("미지정", ""));
  TEAM_MEMBERS.forEach(n => sel.appendChild(new Option(n, n)));
  sel.value = defaultTo || "";
}
/* 일정/공사 담당 (복수 지정): 이름 칩을 토글하는 방식으로 선택 */
let scheduleResponsibleSet = new Set();
let scheduleResponsibleEditable = true;
function renderResponsibleChecks() {
  const wrap = document.getElementById("schedule-responsible-checks");
  wrap.innerHTML = "";

  const allSelected = TEAM_MEMBERS.length > 0 && TEAM_MEMBERS.every(name => scheduleResponsibleSet.has(name));
  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "resp-chip" + (allSelected ? " active" : "");
  allChip.textContent = "전체";
  allChip.setAttribute("aria-pressed", String(allSelected));
  allChip.disabled = !scheduleResponsibleEditable;
  allChip.addEventListener("click", () => {
    scheduleResponsibleSet = allSelected ? new Set() : new Set(TEAM_MEMBERS);
    renderResponsibleChecks();
  });
  wrap.appendChild(allChip);

  TEAM_MEMBERS.forEach(n => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "resp-chip" + (scheduleResponsibleSet.has(n) ? " active" : "");
    chip.textContent = n;
    chip.setAttribute("aria-pressed", String(scheduleResponsibleSet.has(n)));
    chip.disabled = !scheduleResponsibleEditable;
    chip.addEventListener("click", () => {
      if (scheduleResponsibleSet.has(n)) scheduleResponsibleSet.delete(n);
      else scheduleResponsibleSet.add(n);
      renderResponsibleChecks();
    });
    wrap.appendChild(chip);
  });
}

/* ───────── 탭 전환 ───────── */
function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll(".panel").forEach(p => {
    const active = p.id === "panel-" + name;
    p.classList.toggle("active", active);
    p.hidden = !active;
  });
}
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
document.querySelectorAll(".panel").forEach(panel => panel.setAttribute("role", "tabpanel"));
switchTab("dashboard");
document.getElementById("tabbar").addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll(".tab-btn")];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  e.preventDefault();
  const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
});
/* 대시보드 열 헤더 클릭 → 해당 탭으로 전환 */
document.querySelectorAll(".dash-column-header[data-tab]").forEach(h => {
  h.addEventListener("click", (e) => {
    if (e.target.classList.contains("dash-count")) return; // 배지 클릭 시 무시
    switchTab(h.dataset.tab);
  });
});

function pad(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function todayIso() { return isoDate(new Date()); }
function fmtTs(ts) {
  if (!ts) return "-";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function tsMillis(ts) {
  if (!ts) return 0;
  return ts.toDate ? ts.toDate().getTime() : new Date(ts).getTime();
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
/* 유형 표시 라벨 (저장값은 그대로, 화면 표기만 변경) */
function typeLabel(t) { return t === "공사" ? "공사(작업)" : t; }

/* 연속된 날짜들을 "몇일~몇일" 범위로 압축 표시 */
function formatDateRanges(dates) {
  if (!dates || !dates.length) return "-";
  const sorted = [...new Set(dates)].sort();
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const prevDate = new Date(prev + "T00:00:00");
    prevDate.setDate(prevDate.getDate() + 1);
    if (d === isoDate(prevDate)) {
      prev = d;
    } else {
      ranges.push(start === prev ? start : `${start} ~ ${prev}`);
      start = d; prev = d;
    }
  }
  ranges.push(start === prev ? start : `${start} ~ ${prev}`);
  return ranges.join(", ");
}
/* "2026-07-15" → "07/15" (표 안에서 한 줄로 맞추기 위한 축약 표시. 전체 날짜는 title 툴팁으로 확인) */
function mdShort(iso) { return iso.slice(5,7) + "/" + iso.slice(8,10); }
function formatDateRangesShort(dates) {
  if (!dates || !dates.length) return "-";
  const sorted = [...new Set(dates)].sort();
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const prevDate = new Date(prev + "T00:00:00");
    prevDate.setDate(prevDate.getDate() + 1);
    if (d === isoDate(prevDate)) { prev = d; }
    else { ranges.push(start === prev ? mdShort(start) : `${mdShort(start)}~${mdShort(prev)}`); start = d; prev = d; }
  }
  ranges.push(start === prev ? mdShort(start) : `${mdShort(start)}~${mdShort(prev)}`);
  return ranges.join(", ");
}
/* 담당자가 여러 명일 때 표에서 한 줄로 맞추기 위해 축약 ("홍길동, 김철수 외 2명"). 전체 명단은 title 툴팁으로 확인 */
function responsibleShort(list) {
  if (!list.length) return "미지정";
  if (TEAM_MEMBERS.length > 0 && TEAM_MEMBERS.every(name => list.includes(name))) return "전체";
  if (list.length <= 2) return list.join(", ");
  return `${list[0]}, ${list[1]} 외 ${list.length - 2}명`;
}
function responsibleLabel(list) {
  if (!list.length) return "미지정";
  if (TEAM_MEMBERS.length > 0 && TEAM_MEMBERS.every(name => list.includes(name))) return "전체";
  return list.join(", ");
}

/* ════════════════════════════════════════════════
   삭제 / 삭제요청-승인 공용 로직
   작성자 본인이면 즉시 자료보관으로 이동하고, 아니면 작성자에게 삭제요청을 보낸다.
   작성자가 대시보드에서 동의하면 관리자 자료보관으로 이동한다.
   ════════════════════════════════════════════════ */
const COLLECTION_OF = { ticket: "requestTickets", schedule: "schedules", memo: "phoneMemos" };
const LABEL_OF = { ticket: "업무", schedule: "일정/공사", memo: "메모" };
function authorOf(type, rec) {
  if (type === "ticket") return rec.requestedBy;
  if (type === "schedule") return rec.registeredBy;
  if (type === "memo") return rec.createdByName || rec.receivedBy;
  return null;
}
function ownsRecord(type, rec) { return isRecordOwner(type, rec, accountProfile); }
function archivePayload() {
  return { ...archiveFields(currentUser(), currentUid()), archivedAt: serverTimestamp(), updatedAt: serverTimestamp() };
}
async function handleDeleteClick(type, rec) {
  const me = currentUser();
  const author = authorOf(type, rec);
  const label = rec.title || rec.subject || "항목";
  if (type === "ticket") {
    if (!ownsRecord(type, rec) && !isAdmin()) {
      if (rec.deleteRequestedBy) { alert(`이미 ${rec.deleteRequestedBy}님이 삭제를 요청했습니다.`); return false; }
      if (!confirm(`작성자(${author || "미지정"})에게 삭제 승인을 요청할까요?`)) return false;
      await updateDoc(doc(db, "requestTickets", rec.id), { deleteRequestedBy: me, deleteRequestedByUid: currentUid(), deleteRequestedAt: serverTimestamp() });
      await notifyTicketUser(author, rec.id, "delete_requested", `${me}님이 관련업무 삭제를 요청했습니다.`);
      await auditTicket(rec.id, "delete_requested", null, { requestedBy: me });
      return true;
    }
    if (!confirm(`"${label}" 업무를 삭제할까요? 삭제된 업무는 관리자 보관함으로 이동합니다.`)) return false;
    await updateDoc(doc(db, "requestTickets", rec.id), archivePayload());
    await auditTicket(rec.id, "ticket_archived", { archived: false }, { archived: true, archivedBy: me });
    return true;
  }
  if (rec.deleteRequestedBy && !isAdmin()) {
    if (me === author) {
      alert("이미 삭제 요청이 대기 중입니다. 대시보드에서 승인/거절할 수 있습니다.");
    } else {
      alert(`이미 ${rec.deleteRequestedBy}님이 삭제를 요청했습니다. 작성자(${author || "미지정"})의 승인을 기다리는 중입니다.`);
    }
    return false;
  }
  if (ownsRecord(type, rec) || isAdmin()) {
    if (!confirm(`"${label}" 항목을 삭제할까요? 삭제된 자료는 관리자 보관함으로 이동합니다.`)) return false;
    await updateDoc(doc(db, COLLECTION_OF[type], rec.id), archivePayload());
    await auditRecord(type, rec.id, `${type}_archived`, { archived:false }, { archived:true, archivedBy:me });
    return true;
  } else {
    if (!confirm(`본인이 작성한 항목이 아닙니다. 작성자(${author || "미지정"})에게 삭제 요청을 보낼까요?\n작성자가 동의해야 실제로 삭제됩니다.`)) return false;
    await updateDoc(doc(db, COLLECTION_OF[type], rec.id), {
      deleteRequestedBy: me,
      deleteRequestedByUid: currentUid(),
      deleteRequestedAt: serverTimestamp()
    });
    return true;
  }
}
async function approveDelete(type, id) {
  await updateDoc(doc(db, COLLECTION_OF[type], id), archivePayload());
  await auditRecord(type, id, "delete_request_approved", null, { approvedBy: currentUser() });
}
async function denyDelete(type, id) {
  await updateDoc(doc(db, COLLECTION_OF[type], id), { deleteRequestedBy: null, deleteRequestedAt: null });
}
function deleteRequestBadge(rec) {
  return rec.deleteRequestedBy
    ? ` <span class="badge" style="background:var(--alert-bg);color:var(--alert);">삭제요청(${escapeHtml(rec.deleteRequestedBy)})</span>`
    : "";
}
/* 여러 건을 한 번에 삭제/삭제요청 처리 (체크박스 선택 삭제) */
async function bulkDelete(type, allItems, selectedSet) {
  if (selectedSet.size === 0) { alert("선택된 항목이 없습니다"); return; }
  const items = allItems.filter(x => selectedSet.has(x.id));
  const me = currentUser();
  const already = items.filter(x => x.deleteRequestedBy);
  const actionable = items.filter(x => !x.deleteRequestedBy);
  const mine = actionable.filter(x => ownsRecord(type, x) || isAdmin());
  const others = actionable.filter(x => !ownsRecord(type, x) && !isAdmin());
  let msg = `총 ${items.length}건 선택됨\n- 자료보관 이동: ${mine.length}건\n- 삭제 요청 전송(작성자 승인 필요): ${others.length}건`;
  if (already.length) msg += `\n- 이미 삭제 요청 중이라 건너뜀: ${already.length}건`;
  if (!confirm(msg)) return;
  const batch = writeBatch(db);
  for (const rec of mine) {
    batch.update(doc(db, COLLECTION_OF[type], rec.id), archivePayload());
    addAuditToBatch(batch, type, rec.id, `${type}_archived`, { archived:false }, { archived:true, archivedBy:me });
  }
  for (const rec of others) {
    batch.update(doc(db, COLLECTION_OF[type], rec.id), { deleteRequestedBy: me, deleteRequestedByUid: currentUid(), deleteRequestedAt: serverTimestamp() });
  }
  await batch.commit();
  selectedSet.clear();
}

/* ════════════════════════════════════════════════
   업데이트 알림: 진행이력/상세내용이 갱신되면 관련자에게 대시보드로 알림
   전체 담당이면 전체에게, 담당자/요청자 외 다른사람이 쓰면 둘 다에게,
   둘 중 하나가 쓰면 반대쪽에게 알림. 열어보면(markSeen) 알림이 사라짐.
   ════════════════════════════════════════════════ */
/* 일정 담당(복수지정) 필드를 항상 배열로 정규화 (구 데이터: 문자열 이름/"전체"/빈 값 도 지원) */
function responsibleArray(rec) {
  if (Array.isArray(rec.responsible)) return rec.responsible;
  if (rec.responsible === "전체") return [...TEAM_MEMBERS];
  if (rec.responsible) return [rec.responsible];
  return [];
}
/* 관련업무 구성원 정규화: 새 자료는 participants, 기존 자료는 단일 assignee를 사용한다. */
function ticketRecipients(rec) {
  const participants = Array.isArray(rec.participants)
    ? rec.participants.filter(name => name && name !== rec.requestedBy && name !== "관리자")
    : [];
  if (participants.length) return [...new Set(participants)];
  if (Array.isArray(rec.assignees)) return [...new Set(rec.assignees.filter(name => name && name !== rec.requestedBy && name !== "관리자"))];
  return rec.assignee && rec.assignee !== rec.requestedBy && rec.assignee !== "관리자" ? [rec.assignee] : [];
}
function ticketMembers(rec) {
  return [...new Set([rec.requestedBy, ...ticketRecipients(rec)].filter(name => name && name !== "관리자"))];
}
function ticketRecipientLabel(rec) { return ticketRecipients(rec).join(", ") || "수신자 미지정"; }
function roleAOf(type, rec) { return type === "ticket" ? rec.requestedBy : rec.registeredBy; }
function roleBOf(type, rec) { return type === "ticket" ? ticketRecipients(rec) : responsibleArray(rec); }
function lastHistoryAuthor(rec) {
  return (rec.history && rec.history.length) ? rec.history[rec.history.length - 1].author : null;
}
function latestTicketWriter(rec) {
  const lastHistory = rec.history && rec.history.length ? rec.history[rec.history.length - 1] : null;
  const historyTime = lastHistory ? tsMillis(lastHistory.timestamp) : 0;
  const detailTime = tsMillis(rec.lastDetailAt);
  return detailTime >= historyTime ? (rec.lastDetailAuthor || lastHistory?.author || null) : (lastHistory?.author || rec.lastDetailAuthor || null);
}
function notifyTargets(type, rec) {
  const writer = type === "ticket" ? latestTicketWriter(rec) : lastHistoryAuthor(rec);
  if (!writer) return [];
  if (type === "ticket") return ticketMembers(rec).filter(name => name !== writer);
  const a = roleAOf(type, rec);
  if (type === "schedule") {
    // 지정된 담당자 전원 + 등록자(작성자 본인 제외)에게 알림
    const targets = new Set();
    if (a && a !== writer) targets.add(a);
    responsibleArray(rec).forEach(n => { if (n && n !== writer) targets.add(n); });
    return [...targets];
  }
  return [];
}
function updatedMillis(rec) {
  if (rec.updatedAt) return tsMillis(rec.updatedAt);
  const last = rec.history && rec.history.length ? rec.history[rec.history.length - 1] : null;
  return last ? tsMillis(last.timestamp) : 0;
}
/* 이력 항목 종류 구분: "status"(상태/담당자 변경 등 스탬프) vs "note"(세부사항 코멘트).
   과거 데이터는 type이 없으므로 텍스트 패턴으로 추정 */
function historyEntryType(h) {
  if (h.type) return h.type;
  if (/^(상태변경|담당자 변경|새 업무 등록)/.test(h.text || "")) return "status";
  return "note";
}
/* 세부사항/댓글에 안정적인 참조 id 부여 (댓글이 어느 항목에 달렸는지 연결하기 위함) */
function newHistId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
/* 세부사항(노트) 1건에 대해 상대방이 이 내용을 등록 시점 이후에 열어봤는지 여부 (읽음 이력, lastSeenBy 기반 근사치) */
function noteReadBy(rec, entry, candidates) {
  const ts = tsMillis(entry.timestamp);
  return candidates.filter(Boolean).filter(n => n !== entry.author)
    .filter(n => rec.lastSeenBy && rec.lastSeenBy[n] && rec.lastSeenBy[n] >= ts);
}
/* 현재 사용자 기준으로 아직 열어보지 않은 갱신(생성/댓글/변경)이 있는지 여부 */
function hasUnseenUpdate(type, rec) {
  const me = currentUser();
  if (!notifyTargets(type, rec).includes(me)) return false;
  const seen = rec.lastSeenBy && rec.lastSeenBy[me];
  return !seen || seen < updatedMillis(rec);
}
async function markSeen(type, id) {
  const me = currentUser();
  if (!me) return;
  try {
    await updateDoc(doc(db, COLLECTION_OF[type], id), { [`lastSeenBy.${me}`]: Date.now() });
  } catch (e) { /* 문서가 삭제되었거나 권한 문제인 경우 무시 */ }
}

/* ════════════════════════════════════════════════
   날짜 입력 컴포넌트: 숫자 직접입력(탭 불필요) + 팝업 캘린더(주말·공휴일 표시)
   ════════════════════════════════════════════════ */
const dpPopup = document.createElement("div");
dpPopup.id = "dp-popup";
dpPopup.className = "dp-popup";
document.body.appendChild(dpPopup);

let dpActiveInput = null;
let dpViewY, dpViewM;

function dpParse(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, m: mo - 1, d };
}
function dpFormat(y, m, d) {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}
function dpRenderCalendar() {
  const dow = ["일","월","화","수","목","금","토"];
  const firstDow = new Date(dpViewY, dpViewM, 1).getDay();
  const daysInMonth = new Date(dpViewY, dpViewM + 1, 0).getDate();
  const todayIsoStr = todayIso();
  const selected = dpActiveInput ? dpParse(dpActiveInput.value) : null;

  let html = `
    <div class="dp-head">
      <button type="button" class="dp-nav" data-dir="-1">‹</button>
      <div class="dp-title">${dpViewY}년 ${dpViewM + 1}월</div>
      <button type="button" class="dp-nav" data-dir="1">›</button>
    </div>
    <div class="dp-dow-row">${dow.map((d,i) => `<div class="${i===0?'dp-sun':i===6?'dp-sat':''}">${d}</div>`).join("")}</div>
    <div class="dp-grid">`;

  for (let i = 0; i < firstDow; i++) html += `<div class="dp-cell dp-blank"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = dpFormat(dpViewY, dpViewM, d);
    const dowIdx = new Date(dpViewY, dpViewM, d).getDay();
    const hName = holidayName(iso);
    let cls = "dp-cell";
    if (dowIdx === 0) cls += " dp-sun";
    if (dowIdx === 6) cls += " dp-sat";
    if (hName) cls += " dp-holiday";
    if (iso === todayIsoStr) cls += " dp-today";
    if (selected && selected.y === dpViewY && selected.m === dpViewM && selected.d === d) cls += " dp-selected";
    html += `<div class="${cls}" data-iso="${iso}" title="${hName || ""}">${d}</div>`;
  }
  html += `</div>`;
  dpPopup.innerHTML = html;

  dpPopup.querySelectorAll(".dp-nav").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dpViewM += +btn.dataset.dir;
      if (dpViewM < 0) { dpViewM = 11; dpViewY--; }
      if (dpViewM > 11) { dpViewM = 0; dpViewY++; }
      dpRenderCalendar();
    });
  });
  dpPopup.querySelectorAll(".dp-cell[data-iso]").forEach(cell => {
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dpActiveInput) {
        dpActiveInput.value = cell.dataset.iso;
        dpActiveInput.dispatchEvent(new Event("change"));
      }
      dpClose();
    });
  });
}
function dpOpen(input) {
  if (input.disabled) return;
  dpActiveInput = input;
  const parsed = dpParse(input.value) || (() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth(), d: t.getDate() }; })();
  dpViewY = parsed.y; dpViewM = parsed.m;
  dpRenderCalendar();
  const rect = input.getBoundingClientRect();
  dpPopup.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 296)) + "px";
  dpPopup.style.top = (rect.bottom + window.scrollY + 6) + "px";
  dpPopup.classList.add("open");
}
function dpClose() {
  dpPopup.classList.remove("open");
  dpActiveInput = null;
}
document.addEventListener("click", (e) => {
  if (dpPopup.classList.contains("open") && !dpPopup.contains(e.target) && e.target !== dpActiveInput) {
    dpClose();
  }
});
function dpMask(v) {
  const digits = v.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return digits.slice(0,4) + "-" + digits.slice(4);
  return digits.slice(0,4) + "-" + digits.slice(4,6) + "-" + digits.slice(6);
}
const isMobileDevice = window.innerWidth <= 768 || ('ontouchstart' in window);
function initDateField(input) {
  if (isMobileDevice) {
    input.type = "date";
    input.classList.add("date-input");
    return;
  }
  input.classList.add("date-input");
  input.setAttribute("placeholder", "YYYY-MM-DD");
  input.setAttribute("inputmode", "numeric");
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", () => {
    input.value = dpMask(input.value);
    if (dpActiveInput === input) dpRenderCalendar();
  });
  input.addEventListener("focus", () => dpOpen(input));
  input.addEventListener("click", (e) => { e.stopPropagation(); dpOpen(input); });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (input.value && !dpParse(input.value)) input.value = "";
    }, 200);
  });
}
["ticket-due", "ticket-due-edit", "schedule-range-start", "schedule-range-end", "schedule-single-date"]
  .forEach(id => initDateField(document.getElementById(id)));

/* ════════════════════════════════════════════════
   1. 업무관리
   ════════════════════════════════════════════════ */
let tickets = [];
let ticketDetailUnsubscribe = null;
const ticketDetailsById = new Map();

async function auditRecord(type, targetId, action, beforeData, afterData) {
  await addDoc(collection(db, "auditLogs"), {
    targetCollection: COLLECTION_OF[type] || type, targetId, action,
    actorName: currentUser(), actorUid: auth.currentUser?.uid || null,
    before: beforeData || null, after: afterData || null, createdAt: serverTimestamp()
  });
}
function addAuditToBatch(batch, type, targetId, action, beforeData, afterData) {
  batch.set(doc(collection(db, "auditLogs")), {
    targetCollection: COLLECTION_OF[type] || type, targetId, action,
    actorName:currentUser(), actorUid:currentUid(), before:beforeData || null,
    after:afterData || null, createdAt:serverTimestamp()
  });
}
async function auditTicket(ticketId, action, beforeData, afterData) {
  return auditRecord("ticket", ticketId, action, beforeData, afterData);
}

async function notifyTicketUser(name, ticketId, type, message) {
  if (!name || name === currentUser()) return;
  const recipientUid = memberUidByName.get(name) || null;
  await addDoc(collection(db, "userNotifications", notificationOwnerKey(name), "items"), {
    ticketId, type, message, actor: currentUser(), actorUid:currentUid(), recipientName:name, recipientUid,
    createdAt: serverTimestamp(), readAt: null, schemaVersion:SCHEMA_VERSION
  });
}
function addNotificationToBatch(batch, name, ticketId, type, message) {
  if (!name || name === currentUser()) return;
  const recipientUid = memberUidByName.get(name) || null;
  batch.set(doc(collection(db, "userNotifications", notificationOwnerKey(name), "items")), {
    ticketId, type, message, actor:currentUser(), actorUid:currentUid(), recipientName:name, recipientUid,
    createdAt:serverTimestamp(), readAt:null, schemaVersion:SCHEMA_VERSION
  });
}
async function notifyTicketMembers(ticket, type, message, excludedName = currentUser()) {
  const targets = ticketMembers(ticket).filter(name => name !== excludedName);
  if (!targets.length) return;
  const batch = writeBatch(db);
  targets.forEach(name => addNotificationToBatch(batch, name, ticket.id, type, message));
  await batch.commit();
}

async function addTicketDetail(ticketId, text, kind = "detail", author = currentUser()) {
  const detailRef = doc(collection(db, "requestTickets", ticketId, "details"));
  const batch = writeBatch(db);
  batch.set(detailRef, {
    text, kind, author, authorUid: auth.currentUser?.uid || null,
    createdAt: serverTimestamp(), editedAt: null, archived: false
  });
  batch.update(doc(db, "requestTickets", ticketId), {
    lastDetailText: text, lastDetailAuthor: author, lastDetailKind: kind, lastDetailAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  await batch.commit();
  return detailRef;
}

async function ensureTicketDetailsMigrated(ticket) {
  if (ticket.detailsMigrated) return;
  const legacy = (ticket.history || []).filter(h => historyEntryType(h) === "note");
  const batch = writeBatch(db);
  legacy.slice(0, 450).forEach((h, index) => {
    const id = h.id || `legacy-${String(index).padStart(4, "0")}`;
    batch.set(doc(db, "requestTickets", ticket.id, "details", id), {
      text: h.text || "", kind: "detail", author: h.author || ticket.requestedBy || "-",
      createdAt: h.timestamp || ticket.requestedAt || serverTimestamp(), editedAt: h.editedAt || null,
      archived: false, migrated: true
    }, { merge: true });
  });
  batch.update(doc(db, "requestTickets", ticket.id), { detailsMigrated: true });
  await batch.commit();
}

function subscribeTicketDetails(ticket) {
  if (ticketDetailUnsubscribe) ticketDetailUnsubscribe();
  ensureTicketDetailsMigrated(ticket).catch(console.error);
  ticketDetailUnsubscribe = onSnapshot(
    query(collection(db, "requestTickets", ticket.id, "details"), orderBy("createdAt", "asc"), limit(100)),
    snap => {
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d.archived);
      ticketDetailsById.set(ticket.id, rows);
      if (ticketEditingId === ticket.id) renderTicketNoteHistory(ticket, rows);
    }
  );
}
const ticketFilterRequester = document.getElementById("ticket-filter-requester");
TEAM_MEMBERS.forEach(n => ticketFilterRequester.appendChild(new Option(n, n)));

let optimizedMemberQueries = false;
try { const config = await getDoc(doc(db, "system", "app")); optimizedMemberQueries = config.exists() && config.data().scheduleMonthIndexReady === true; } catch (_) {}
const ticketListQuery = optimizedMemberQueries
  ? query(collection(db, "requestTickets"), where("participantUids", "array-contains", currentUid()), limit(300))
  : query(collection(db, "requestTickets"), orderBy("requestedAt", "desc"), limit(300));
onSnapshot(ticketListQuery, (snap) => {
  tickets = snap.docs.map(d => {
    const row = { id: d.id, ...d.data() };
    if (["요청됨", "미확인"].includes(row.status)) row.status = "미수신";
    if (row.status === "확인됨") row.status = "열람";
    return row;
  }).filter(t => !t.archived).sort((a, b) => tsMillis(b.requestedAt) - tsMillis(a.requestedAt));
  renderTickets();
  renderDashboard();
}, error => reportDataError("관련업무 불러오기", error));

document.getElementById("ticket-filter-status").addEventListener("change", renderTickets);
ticketFilterRequester.addEventListener("change", renderTickets);
document.getElementById("ticket-filter-overdue").addEventListener("change", renderTickets);
/* 수신/발송 버튼은 더 이상 화면을 전환하지 않고, 두 구역이 항상 함께(위/아래) 보이므로
   해당 구역으로 부드럽게 스크롤 이동하는 바로가기 역할만 함 */
document.getElementById("ticket-dir-received").addEventListener("click", () => {
  document.getElementById("ticket-section-received").scrollIntoView({ behavior: "smooth", block: "start" });
});
document.getElementById("ticket-dir-sent").addEventListener("click", () => {
  document.getElementById("ticket-section-sent").scrollIntoView({ behavior: "smooth", block: "start" });
});

function isTicketOverdue(t) {
  if (!t.dueDate) return false;
  if (t.status === "진행중" || t.status === "완료") return false;
  return t.dueDate < todayIso();
}
function ticketDeadlineLevel(t) {
  if (!t.dueDate || t.status === "완료") return "";
  const today = new Date(todayIso() + "T00:00:00");
  const due = new Date(t.dueDate + "T00:00:00");
  const days = Math.round((due - today) / 86400000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 3) return "soon";
  return "";
}

/* 세부사항(요청 내용 + 추가사항) 전체를 리스트에서 바로 확인할 수 있도록 인라인으로 스택 표시 */
function buildTicketNotesCell(t) {
  const notes = (t.history || []).filter(h => historyEntryType(h) === "note");
  if (!notes.length) return `<div class="ticket-notes-cell"><span class="small-note">세부사항 없음</span></div>`;
  const items = notes.map(h =>
    `<div class="tn-item"><div class="tn-meta">${escapeHtml(h.author || "-")} · ${fmtTs(h.timestamp)}</div><div>${escapeHtml(h.text)}</div></div>`
  ).join("");
  return `<div class="ticket-notes-cell">${items}</div>`;
}

/* "요청일(희망기한)"을 월/일만 간략하게 표시 ("07/14(~07/20)") */
function ticketDateShort(t) {
  const reqD = t.requestedAt ? (t.requestedAt.toDate ? t.requestedAt.toDate() : new Date(t.requestedAt)) : null;
  const reqStr = reqD ? `${pad(reqD.getMonth()+1)}/${pad(reqD.getDate())}` : "-";
  return t.dueDate ? `${reqStr}(~${mdShort(t.dueDate)})` : reqStr;
}

function buildTicketRow(t, me) {
  const overdue = isTicketOverdue(t);
  const deadlineLevel = ticketDeadlineLevel(t);
  const isAuthor = ownsRecord("ticket", t) || isAdmin();
  const unseen = hasUnseenUpdate("ticket", t);
  const tr = document.createElement("tr");
  if (overdue) tr.classList.add("row-overdue", "breathing");
  if (deadlineLevel) tr.classList.add(`deadline-${deadlineLevel}`);
  if (t.status === "완료") tr.classList.add("row-done");
  if (unseen) tr.classList.add("row-update-pulse");
  const unseenDot = unseen ? `<span class="blink-dot" title="새 소식이 있습니다"></span>` : "";
  const firstNote = (t.history || []).find(h => historyEntryType(h) === "note");
  const contentText = firstNote ? firstNote.text : "-";
  const recipientLabel = ticketRecipientLabel(t);
  const counterpart = t.requestedBy === me ? recipientLabel : `${t.requestedBy || "-"} · 구성원 ${recipientLabel}`;
  const openedNames = Object.keys(t.openedBy || {});
  const receiptText = openedNames.length
    ? `열람 ${openedNames.join(", ")}`
    : t.receivedAt ? `수신확인 ${t.receivedBy || "-"} · ${fmtTs(t.receivedAt)}` : "수신대기";
  const editIcon = isAuthor ? `<button type="button" class="row-edit-btn" title="수정">✏️</button>` : "";
  tr.innerHTML = `
    <td>${unseenDot}${escapeHtml(t.title)}${deleteRequestBadge(t)}${editIcon}</td>
    <td title="${escapeHtml(receiptText)}">${escapeHtml(counterpart || "-")}<div class="small-note">${escapeHtml(receiptText)}</div></td>
    <td class="ticket-content-cell" title="${escapeHtml(contentText)}">${escapeHtml(contentText)}</td>
    <td title="${t.requestedAt ? fmtTs(t.requestedAt) : "-"}${t.dueDate ? " (희망기한 " + escapeHtml(t.dueDate) + ")" : ""}">${ticketDateShort(t)} ${overdue ? "⚠️" : ""}</td>
    <td><span class="badge ${t.status}">${t.status}</span></td>
    <td>${buildTicketNotesCell(t)}</td>
    <td class="td-del"><button type="button" class="row-delete-btn" title="삭제">🗑</button></td>
  `;
  tr.addEventListener("click", () => openTicketDetail(t.id, true));
  const editBtn = tr.querySelector(".row-edit-btn");
  if (editBtn) editBtn.addEventListener("click", (e) => { e.stopPropagation(); openTicketDetail(t.id, false); });
  tr.querySelector(".row-delete-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    handleDeleteClick("ticket", t);
  });
  return tr;
}

function renderTicketGroup(rows, me, tbodyId, countId, btnId, sectionCountId) {
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = "";
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">표시할 업무가 없습니다</td></tr>`;
  } else {
    rows.forEach(t => tbody.appendChild(buildTicketRow(t, me)));
  }
  const hasUpdate = rows.some(t => hasUnseenUpdate("ticket", t));
  document.getElementById(countId).textContent = String(rows.length);
  document.getElementById(sectionCountId).textContent = `(${rows.length}건)`;
  document.getElementById(btnId).classList.toggle("has-update", hasUpdate);
}

function renderTickets() {
  const statusF = document.getElementById("ticket-filter-status").value;
  const reqF = ticketFilterRequester.value;
  const overdueOnly = document.getElementById("ticket-filter-overdue").checked;
  const me = currentUser();

  const passesFilters = (t) => {
    if (statusF !== "all" && t.status !== statusF) return false;
    if (reqF !== "all" && t.requestedBy !== reqF) return false;
    if (overdueOnly && !isTicketOverdue(t)) return false;
    return true;
  };

  // 구성원 목록이 없는 기존 자료만 이전 방식대로 요청자 외 전원에게 보이도록 유지한다.
  const received = tickets.filter(t => {
    const recipients = ticketRecipients(t);
    return (isAdmin() || (recipients.length ? recipients.includes(me) : t.requestedBy !== me)) && passesFilters(t);
  });
  const sent = isAdmin() ? [] : tickets.filter(t => t.requestedBy === me && passesFilters(t));

  renderTicketGroup(received, me, "ticket-tbody-received", "ticket-count-received", "ticket-dir-received", "ticket-section-received-count");
  renderTicketGroup(sent, me, "ticket-tbody-sent", "ticket-count-sent", "ticket-dir-sent", "ticket-section-sent-count");
}

const ticketOverlay = document.getElementById("ticket-modal-overlay");
let ticketEditingId = null;
let ticketEditMode = false; // 지금 열려있는 업무 모달이 실제 수정모드인지(true) 열람모드인지(false)
let ticketRecipientSet = new Set();
let ticketRecipientEditSet = new Set();

function renderTicketRecipientChecks(wrapId, selectedSet, requester) {
  const wrap = document.getElementById(wrapId);
  const available = TEAM_MEMBERS.filter(name => name !== requester);
  wrap.innerHTML = "";
  const allSelected = available.length > 0 && available.every(name => selectedSet.has(name));
  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "resp-chip" + (allSelected ? " active" : "");
  allChip.textContent = "전체";
  allChip.setAttribute("aria-pressed", String(allSelected));
  allChip.addEventListener("click", () => {
    if (allSelected) selectedSet.clear(); else available.forEach(name => selectedSet.add(name));
    renderTicketRecipientChecks(wrapId, selectedSet, requester);
  });
  wrap.appendChild(allChip);
  available.forEach(name => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "resp-chip" + (selectedSet.has(name) ? " active" : "");
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(selectedSet.has(name)));
    chip.addEventListener("click", () => {
      if (selectedSet.has(name)) selectedSet.delete(name); else selectedSet.add(name);
      renderTicketRecipientChecks(wrapId, selectedSet, requester);
    });
    wrap.appendChild(chip);
  });
}

document.getElementById("ticket-new-btn").addEventListener("click", () => {
  ticketEditingId = null;
  document.getElementById("ticket-modal-title").textContent = "새 업무 등록";
  document.getElementById("ticket-new-fields").style.display = "block";
  document.getElementById("ticket-detail-fields").style.display = "none";
  document.getElementById("ticket-title").value = "";
  document.getElementById("ticket-due").value = "";
  document.getElementById("ticket-content").value = "";
  document.getElementById("ticket-requester-display").textContent = currentUser();
  ticketRecipientSet = new Set();
  renderTicketRecipientChecks("ticket-assignee-checks", ticketRecipientSet, currentUser());
  document.getElementById("ticket-delete").style.display = "none";
  ticketOverlay.classList.add("open");
});

/* 세부사항 표시용 상태 라벨 텍스트("요청일(희망기한)") */
function ticketDatesLabel(t) {
  const req = t.requestedAt ? fmtTs(t.requestedAt).slice(0, 10) : "-";
  return t.dueDate ? `${req} (희망기한 ~${t.dueDate})` : req;
}
function normalizedTicketStatus(status) {
  if (["요청됨", "미확인"].includes(status)) return "미수신";
  if (status === "확인됨") return "열람";
  return status || "미수신";
}
function ticketStatusBadge(status) {
  const value = normalizedTicketStatus(status);
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

/* forceView === true 이면 작성자(요청자) 여부와 관계없이 항상 열람(읽기전용) 모드로 연다.
   forceView가 없으면(=제목 옆 [edit] 아이콘/알림 클릭 등) 기존처럼 작성자 본인일 때만 수정 가능 */
function openTicketDetail(id, forceView) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  ticketEditingId = id;
  const me = currentUser();
  const isAuthor = ownsRecord("ticket", t) || isAdmin();
  const recipients = ticketRecipients(t);
  const isRecipient = recipients.length ? recipients.includes(me) : t.requestedBy !== me;
  const editMode = forceView ? false : isAuthor;
  ticketEditMode = editMode;

  /* 각 수신자의 최초 열람을 따로 기록하고, 업무방 공통 상태는 첫 열람 때만 변경한다. */
  if (!isAuthor && isRecipient && !(t.openedBy && t.openedBy[me])) {
    const firstOpen = ["미수신", "미확인", "요청됨"].includes(t.status);
    const history = (t.history || []).slice();
    history.push({ id: newHistId(), text: `열람: ${me}`, author: me, timestamp: new Date(), type: "status" });
    if (firstOpen) t.status = "열람";
    t.history = history;
    t.openedBy = { ...(t.openedBy || {}), [me]: Date.now() };
    const openPayload = { [`openedBy.${me}`]: Date.now(), history, updatedAt: serverTimestamp() };
    if (firstOpen) Object.assign(openPayload, { status:"열람", receivedBy:me, receivedAt:serverTimestamp() });
    updateDoc(doc(db, "requestTickets", id), openPayload).then(() => Promise.all([
      notifyTicketMembers(t, "opened", `${me}님이 업무방을 열람했습니다.`, me),
      auditTicket(id, "ticket_opened", { status:firstOpen ? "미수신" : t.status }, { status:t.status, receivedBy:me })
    ])).catch(console.error);
  }

  /* 어떤 부분이 갱신되어 아직 못 본 상태인지 판단 (제목 자체 = 신규등록, 진행상태, 세부사항 중 하나) */
  const allHist = t.history || [];
  const lastEntry = allHist.length ? allHist[allHist.length - 1] : null;
  const unseen = hasUnseenUpdate("ticket", t);
  const isNewRegistration = !!(lastEntry && historyEntryType(lastEntry) === "status" && /^새 업무 등록/.test(lastEntry.text || ""));
  const blinkTitle = unseen && isNewRegistration;
  const blinkStatus = unseen && lastEntry && !isNewRegistration && historyEntryType(lastEntry) === "status";
  const blinkNote = unseen && lastEntry && historyEntryType(lastEntry) === "note";

  document.getElementById("ticket-modal-title").innerHTML = (blinkTitle ? `<span class="blink-dot"></span>` : "") + escapeHtml(t.title) + (editMode ? "" : " (열람)");
  document.getElementById("ticket-status-label").innerHTML = (blinkStatus ? `<span class="blink-dot"></span>` : "") + "진행상태";
  document.getElementById("ticket-note-label").innerHTML = (blinkNote ? `<span class="blink-dot"></span>` : "") + "세부사항";
  document.getElementById("ticket-new-fields").style.display = "none";
  document.getElementById("ticket-detail-fields").style.display = "block";

  document.getElementById("ticket-edit-summary").style.display = editMode ? "block" : "none";
  document.getElementById("ticket-view-summary").style.display = editMode ? "none" : "block";
  document.getElementById("ticket-readonly-note").style.display = editMode ? "none" : "block";
  document.getElementById("ticket-readonly-note").textContent = isAuthor
    ? "제목 옆 편집 아이콘(✏️)을 클릭하면 수정할 수 있습니다."
    : "작성자(요청자)만 위 항목을 수정할 수 있으며, 업무방 구성원은 세부사항을 계속 남길 수 있습니다.";

  if (editMode) {
    document.getElementById("ticket-status-badge-edit").innerHTML = ticketStatusBadge(t.status);
    document.getElementById("ticket-due-edit").value = t.dueDate || "";
    document.getElementById("ticket-requester-display-edit").textContent = t.requestedBy || "-";
    ticketRecipientEditSet = new Set(ticketRecipients(t));
    renderTicketRecipientChecks("ticket-assignee-edit-checks", ticketRecipientEditSet, t.requestedBy);
  } else {
    document.getElementById("tv-requester").textContent = t.requestedBy || "-";
    document.getElementById("tv-assignee").textContent = ticketRecipientLabel(t);
    document.getElementById("tv-dates").textContent = ticketDatesLabel(t);
    document.getElementById("tv-status").innerHTML = ticketStatusBadge(t.status);
    const openedNames = Object.keys(t.openedBy || {});
    document.getElementById("tv-received").textContent = openedNames.length
      ? openedNames.join(", ")
      : t.receivedAt ? `${t.receivedBy || "-"} · ${fmtTs(t.receivedAt)}` : "아직 수신하지 않음";
  }
  document.getElementById("ticket-note-text").value = "";
  subscribeTicketDetails(t);
  renderTicketWorkActions(t, isRecipient, isAuthor);

  const statusHist = allHist.filter(h => historyEntryType(h) === "status");
  const noteHist = ticketDetailsById.get(t.id) || allHist.filter(h => historyEntryType(h) === "note");

  const statusHistEl = document.getElementById("ticket-status-history-list");
  statusHistEl.innerHTML = "";
  statusHist.slice().reverse().forEach(h => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `<div class="meta">${fmtTs(h.timestamp)}</div><div>${escapeHtml(h.text)}</div>`;
    statusHistEl.appendChild(div);
  });
  if (!statusHist.length) statusHistEl.innerHTML = `<div class="small-note">이력이 없습니다</div>`;

  try {
    renderTicketNoteHistory(t, noteHist);
  } catch (e) {
    console.error("세부사항 렌더링 오류", e);
    document.getElementById("ticket-note-history-list").innerHTML = `<div class="small-note">세부사항을 표시하는 중 오류가 발생했습니다</div>`;
  }

  document.getElementById("ticket-delete").style.display = "inline-block";
  ticketOverlay.classList.add("open");
  markSeen("ticket", id);
}

/* 세부사항 목록: 시간순(오래된 것이 위) + 각 항목에 댓글(답글) 달기 + 읽음 이력 표시 */
function renderTicketNoteHistory(t, noteHist) {
  const noteHistEl = document.getElementById("ticket-note-history-list");
  noteHistEl.innerHTML = "";
  if (!noteHist.length) { noteHistEl.innerHTML = `<div class="small-note">세부사항이 없습니다</div>`; return; }
  const candidates = ticketMembers(t);

  /* 댓글(답글) 기능은 제거하고, 한 업무에 대한 모든 세부사항/추가사항을 시간순(오래된 것이 위)
     하나의 트리(목록)로 이어서 보여줌 - 계속 업데이트하거나 의견을 더하는 용도이므로 단순한 목록이 더 직관적 */
  noteHist.forEach(h => {
    const div = document.createElement("div");
    div.className = "history-item";
    const readBy = h.id ? noteReadBy(t, { ...h, timestamp: h.createdAt || h.timestamp }, candidates) : [];
    const readNote = readBy.length ? `<div class="small-note">읽음: ${readBy.map(escapeHtml).join(", ")}</div>` : "";
    div.innerHTML = `<div class="meta">${h.author || "-"} · ${fmtTs(h.createdAt || h.timestamp)}${h.editedAt ? " (수정됨)" : ""}</div><div>${escapeHtml(h.text)}</div>${readNote}`;
    if (h.id && ticketEditingId !== null) {
      // 본인이 쓴 세부사항은 수정·삭제 가능. 관리자 계정은 예외 없이 전부 수정/삭제 가능
      const canModify = isAdmin() || h.author === currentUser();
      if (canModify) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn-secondary";
        editBtn.style.cssText = "padding:3px 10px; font-size:12.5px; margin-top:6px; margin-right:6px;";
        editBtn.textContent = "수정";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-secondary btn-danger-outline";
        delBtn.style.cssText = "padding:3px 10px; font-size:12.5px; margin-top:6px; margin-right:6px;";
        delBtn.textContent = "삭제";
        const editBox = document.createElement("div");
        editBox.style.cssText = "display:none; margin-top:8px; gap:6px; flex-direction:column;";
        const editTa = document.createElement("textarea");
        editTa.value = h.text;
        editTa.style.cssText = "min-height:50px;";
        const editSaveBtn = document.createElement("button");
        editSaveBtn.type = "button";
        editSaveBtn.className = "btn-primary";
        editSaveBtn.style.cssText = "padding:6px 14px; font-size:13px; align-self:flex-end;";
        editSaveBtn.textContent = "저장";
        editBtn.addEventListener("click", () => {
          editBox.style.display = editBox.style.display === "none" ? "flex" : "none";
        });
        editSaveBtn.addEventListener("click", async () => {
          const txt = editTa.value.trim();
          if (!txt) { alert("내용을 입력하세요"); return; }
          await editTicketNote(h.id, txt);
        });
        editBox.appendChild(editTa);
        editBox.appendChild(editSaveBtn);
        delBtn.addEventListener("click", async () => {
          if (!confirm("이 항목을 삭제할까요?")) return;
          await deleteTicketNote(h.id);
        });
        div.appendChild(editBtn);
        div.appendChild(delBtn);
        div.appendChild(editBox);
      }
    }
    noteHistEl.appendChild(div);
  });
}

/* 본인이 쓴 세부사항 수정 */
async function editTicketNote(id, text) {
  if (ticketEditingId === null) return;
  const ticket = tickets.find(item => item.id === ticketEditingId);
  await updateDoc(doc(db, "requestTickets", ticketEditingId, "details", id), { text, editedAt: serverTimestamp() });
  await Promise.all([
    auditTicket(ticketEditingId, "detail_edited", null, { detailId:id }),
    ticket ? notifyTicketMembers(ticket, "detail_edited", `${currentUser()}님이 세부사항을 수정했습니다.`) : Promise.resolve()
  ]);
}

/* 본인이 쓴 세부사항/댓글 삭제 */
async function deleteTicketNote(id) {
  if (ticketEditingId === null) return;
  const ticket = tickets.find(item => item.id === ticketEditingId);
  try {
    await updateDoc(doc(db, "requestTickets", ticketEditingId, "details", id), { archived: true, archivedAt: serverTimestamp(), archivedBy: currentUser() });
    await Promise.all([
      auditTicket(ticketEditingId, "detail_archived", null, { detailId:id }),
      ticket ? notifyTicketMembers(ticket, "detail_archived", `${currentUser()}님이 세부사항을 삭제했습니다.`) : Promise.resolve()
    ]);
  } catch (error) {
    console.error("세부사항 삭제 오류", error);
    alert("세부사항을 삭제하지 못했습니다. 최신 Firestore 보안 규칙이 게시되었는지 확인해 주세요.");
  }
}

function renderTicketWorkActions(ticket, isRecipient, isAuthor) {
  const wrap = document.getElementById("ticket-work-actions");
  wrap.innerHTML = "";
  const transitions = [];
  if (isRecipient && ticket.status === "열람") transitions.push(["접수", "접수"]);
  if (isRecipient && ticket.status === "접수") transitions.push(["진행 시작", "진행중"]);
  if (isRecipient && ["접수", "진행중"].includes(ticket.status)) transitions.push(["보류", "보류"], ["완료", "완료"]);
  if ((isRecipient || isAuthor) && ticket.status === "보류") transitions.push(["진행 재개", "진행중"]);
  if ((isRecipient || isAuthor) && ticket.status === "완료") transitions.push(["업무 재개", "진행중"]);
  wrap.style.display = transitions.length ? "flex" : "none";
  transitions.forEach(([label, status]) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = "btn-primary"; button.textContent = label;
    button.onclick = async () => {
      const reason = ticket.status === "완료" ? prompt("업무 재개 사유를 입력하세요") : "";
      if (ticket.status === "완료" && !reason) return;
      button.disabled = true; button.textContent = "처리 중...";
      try {
        const before = ticket.status;
        const detailText = reason ? `업무 재개: ${reason}` : `상태 변경: ${before} → ${status}`;
        const batch = writeBatch(db);
        batch.update(doc(db, "requestTickets", ticket.id), {
          status, updatedAt:serverTimestamp(), reopenedAt:before === "완료" ? serverTimestamp() : null,
          reopenedBy:before === "완료" ? currentUser() : null, lastDetailText:detailText,
          lastDetailAuthor:currentUser(), lastDetailAuthorUid:currentUid(), lastDetailKind:"status", lastDetailAt:serverTimestamp()
        });
        batch.set(doc(collection(db, "requestTickets", ticket.id, "details")), {
          text:detailText, kind:"status", author:currentUser(), authorUid:currentUid(), createdAt:serverTimestamp(), editedAt:null, archived:false, schemaVersion:SCHEMA_VERSION
        });
        ticketMembers(ticket).filter(name => name !== currentUser()).forEach(name => addNotificationToBatch(batch, name, ticket.id, "status", `${currentUser()}님이 상태를 ${status}(으)로 변경했습니다.`));
        addAuditToBatch(batch, "ticket", ticket.id, before === "완료" ? "ticket_reopened" : "status_changed", { status:before }, { status, reason:reason || null });
        await batch.commit();
        ticketOverlay.classList.remove("open");
      } catch (e) { alert("처리하지 못했습니다. 다시 시도해 주세요."); button.disabled = false; button.textContent = label; }
    };
    wrap.appendChild(button);
  });
}

document.getElementById("ticket-cancel").addEventListener("click", () => ticketOverlay.classList.remove("open"));

document.getElementById("ticket-delete").addEventListener("click", async () => {
  if (ticketEditingId === null) return;
  const t = tickets.find(x => x.id === ticketEditingId);
  if (!t) return;
  const done = await handleDeleteClick("ticket", t);
  if (done) ticketOverlay.classList.remove("open");
});

document.getElementById("ticket-save").addEventListener("click", async () => {
  const saveButton = document.getElementById("ticket-save");
  if (saveButton.disabled) return;
  const originalSaveText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "저장 중...";
  try {
  if (ticketEditingId === null) {
    // 새 업무 생성 (신규 등록 시 상태는 항상 "미확인"에서 시작)
    const title = document.getElementById("ticket-title").value.trim();
    if (!title) { alert("제목을 입력하세요"); return; }
    const requester = currentUser();
    const recipients = TEAM_MEMBERS.filter(name => ticketRecipientSet.has(name) && name !== requester);
    if (!recipients.length) { alert("수신자를 한 명 이상 선택하세요"); return; }
    const due = document.getElementById("ticket-due").value || null;
    const content = document.getElementById("ticket-content").value.trim();
    const initialHistory = [{ id:newHistId(), text:`새 업무 등록 · 구성원: ${recipients.join(", ")}`, author:requester, timestamp:new Date(), type:"status" }];
    const ticketRef = doc(collection(db, "requestTickets"));
    const batch = writeBatch(db);
    const ticketPayload = {
      title, requestedBy: requester, requestedByUid: currentUid(), requestedAt: serverTimestamp(),
      assignee: recipients[0], assigneeUid:memberUidByName.get(recipients[0]) || null,
      participants: [requester, ...recipients], participantUids:[currentUid(), ...recipients.map(name => memberUidByName.get(name)).filter(Boolean)], dueDate: due,
      status: "미수신", receivedBy: null, receivedAt: null, openedBy: {}, history: initialHistory,
      archived: false, detailsMigrated: true, schemaVersion: SCHEMA_VERSION, updatedAt: serverTimestamp()
    };
    if (content) Object.assign(ticketPayload, { lastDetailText:content, lastDetailAuthor:requester, lastDetailAuthorUid:currentUid(), lastDetailKind:"detail", lastDetailAt:serverTimestamp() });
    batch.set(ticketRef, ticketPayload);
    if (content) {
      batch.set(doc(collection(db, "requestTickets", ticketRef.id, "details")), { text:content, kind:"detail", author:requester, authorUid:currentUid(), createdAt:serverTimestamp(), editedAt:null, archived:false, schemaVersion:SCHEMA_VERSION });
    }
    recipients.forEach(name => addNotificationToBatch(batch, name, ticketRef.id, "new_ticket", `${requester}님이 새 업무방을 만들었습니다: ${title}`));
    addAuditToBatch(batch, "ticket", ticketRef.id, "ticket_created", null, { title, requestedBy:requester, participants:[requester, ...recipients], dueDate:due });
    await batch.commit();
  } else {
    const t = tickets.find(x => x.id === ticketEditingId);
    const noteText = document.getElementById("ticket-note-text").value.trim();
    const author = currentUser();

    if (!ticketEditMode) {
      if (!noteText) { alert("추가할 내용을 입력하세요"); return; }
      await addTicketDetail(ticketEditingId, noteText);
      await Promise.all([
        notifyTicketMembers(t, "detail", `${author}님이 세부사항을 추가했습니다.`),
        auditTicket(t.id, "detail_added", null, { author })
      ]);
      ticketOverlay.classList.remove("open");
      return;
    }

    // 수정 모드(작성자 본인): 기한·구성원·추가사항만 수정. 상태는 단계 버튼으로만 변경한다.
    const newDue = document.getElementById("ticket-due-edit").value || null;
    const oldRecipients = ticketRecipients(t);
    const newRecipients = TEAM_MEMBERS.filter(name => ticketRecipientEditSet.has(name) && name !== t.requestedBy);
    if (!newRecipients.length) { alert("구성원을 한 명 이상 선택하세요"); return; }
    const recipientsChanged = oldRecipients.slice().sort().join("|") !== newRecipients.slice().sort().join("|");

    let changeReason = null;
    if (recipientsChanged && (t.receivedAt || Object.keys(t.openedBy || {}).length)) {
      changeReason = prompt("이미 열람된 업무입니다. 구성원 변경 사유를 입력하세요.");
      if (!changeReason) return;
    }

    const history = (t.history || []).slice();
    if (newDue !== t.dueDate) history.push({ id:newHistId(), text:`희망기한 변경: ${t.dueDate || "미지정"} → ${newDue || "미지정"}`, author, timestamp:new Date(), type:"status" });
    if (recipientsChanged) history.push({ id:newHistId(), text:`구성원 변경: ${oldRecipients.join(", ") || "미지정"} → ${newRecipients.join(", ")}${changeReason ? ` · 사유: ${changeReason}` : ""}`, author, timestamp:new Date(), type:"status" });
    await updateDoc(doc(db, "requestTickets", ticketEditingId), {
      status: normalizedTicketStatus(t.status), dueDate: newDue,
      requestedByUid:t.requestedByUid || memberUidByName.get(t.requestedBy) || currentUid(),
      assignee: newRecipients[0], assigneeUid:memberUidByName.get(newRecipients[0]) || null,
      participants: [t.requestedBy, ...newRecipients], participantUids:[t.requestedByUid || memberUidByName.get(t.requestedBy), ...newRecipients.map(name => memberUidByName.get(name))].filter(Boolean),
      history, updatedAt: serverTimestamp()
    });
    if (noteText) await addTicketDetail(ticketEditingId, noteText);
    const updatedTicket = { ...t, assignee:newRecipients[0], participants:[t.requestedBy, ...newRecipients], dueDate:newDue };
    const jobs = [];
    if (noteText) jobs.push(notifyTicketMembers(updatedTicket, "detail", `${author}님이 세부사항을 추가했습니다.`));
    if (newDue !== t.dueDate) jobs.push(notifyTicketMembers(updatedTicket, "due_changed", `희망기한이 ${newDue || "미지정"}(으)로 변경되었습니다.`));
    if (recipientsChanged) {
      const allAffected = new Set([...oldRecipients, ...newRecipients, t.requestedBy]);
      allAffected.delete(author);
      allAffected.forEach(name => jobs.push(notifyTicketUser(name, t.id, "participants_changed", `${author}님이 업무방 구성원을 변경했습니다.${changeReason ? ` 사유: ${changeReason}` : ""}`)));
    }
    jobs.push(auditTicket(t.id, "ticket_updated", { status:t.status, dueDate:t.dueDate, participants:ticketMembers(t) }, { status:normalizedTicketStatus(t.status), dueDate:newDue, participants:ticketMembers(updatedTicket), reason:changeReason }));
    await Promise.all(jobs);
  }
  ticketOverlay.classList.remove("open");
  } catch (e) {
    console.error("관련업무 저장 오류", e);
    alert("저장하지 못했습니다. 입력 내용은 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요.");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalSaveText;
  }
});

/* ════════════════════════════════════════════════
   2. 일정 / 공사 등록
   ════════════════════════════════════════════════ */
let schedules = [];
let selectedScheduleIds = new Set();
let lastRenderedScheduleIds = [];
let scheduleViewMode = "list"; // "list" | "calendar"
/* 일정의 대표 날짜 (가장 이른 날짜) - 날짜순 정렬 및 오늘 구분선 위치 판단에 사용 */
function earliestDate(s) {
  return (Array.isArray(s.dates) && s.dates.length) ? [...s.dates].sort()[0] : "9999-99-99";
}
onSnapshot(query(collection(db, "schedules"), orderBy("registeredAt", "desc"), limit(500)), (snap) => {
  schedules = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.archived);
  schedules.sort((a, b) => earliestDate(a).localeCompare(earliestDate(b)) || tsMillis(a.registeredAt) - tsMillis(b.registeredAt)); // 날짜순(이전 → 이후)
  renderSchedules();
  if (scheduleViewMode === "calendar") renderScheduleCalendar();
  renderDashboard();
}, error => reportDataError("일정 불러오기", error));

function appendFocusGroupHeader(tbody, label, count, kind, colspan) {
  if (kind === "team" && tbody.children.length) {
    const spacer = document.createElement("tr");
    spacer.className = "focus-group-spacer";
    spacer.innerHTML = `<td colspan="${colspan}" aria-hidden="true"></td>`;
    tbody.appendChild(spacer);
  }
  const row = document.createElement("tr");
  row.className = "focus-group-row " + kind;
  row.innerHTML = `<td colspan="${colspan}">${escapeHtml(label)}<span class="focus-group-count">${count}건</span></td>`;
  tbody.appendChild(row);
}

function renderSchedules() {
  lastRenderedScheduleIds = schedules.map(s => s.id);
  const tbody = document.getElementById("schedule-tbody");
  tbody.innerHTML = "";
  const me = currentUser();
  const groups = [
    { label:"내 관련 일정", kind:"mine", items:schedules.filter(s => s.registeredBy === me || responsibleArray(s).includes(me)) },
    { label:"시설팀 공유 일정", kind:"team", items:schedules.filter(s => s.registeredBy !== me && !responsibleArray(s).includes(me)) }
  ];
  const today = todayIso();

  groups.forEach(group => {
    appendFocusGroupHeader(tbody, group.label, group.items.length, group.kind, 8);
    if (!group.items.length) {
      const empty = document.createElement("tr");
      empty.className = "focus-group-empty";
      empty.innerHTML = `<td colspan="8">해당 일정이 없습니다</td>`;
      tbody.appendChild(empty);
      return;
    }

    let todayDividerShown = false;
    group.items.forEach(s => {
      if (!todayDividerShown && earliestDate(s) >= today) {
        todayDividerShown = true;
        const divider = document.createElement("tr");
        divider.style.cursor = "default";
        divider.innerHTML = `<td colspan="8" style="background:var(--bg); color:var(--ink-soft); font-weight:800; text-align:center; padding:7px; border-top:1px dashed var(--line-strong); border-bottom:1px dashed var(--line-strong);">오늘 (${today})</td>`;
        tbody.appendChild(divider);
      }
      const tr = document.createElement("tr");
      if (Array.isArray(s.dates) && s.dates.includes(today)) tr.classList.add("row-active-today");
      const respArr = responsibleArray(s);
      const isAuthor = ownsRecord("schedule", s) || isAdmin();
      const editIcon = isAuthor ? `<button type="button" class="row-edit-btn" title="수정">✏️</button>` : "";
      tr.innerHTML = `
        <td class="td-check"><input type="checkbox" class="row-check" ${selectedScheduleIds.has(s.id) ? "checked" : ""} /></td>
        <td title="${escapeHtml(s.title)}">${escapeHtml(s.title)}${deleteRequestBadge(s)}${editIcon}</td>
        <td title="${escapeHtml(typeLabel(s.type))}"><span class="badge type-${s.type}">${escapeHtml(s.type)}</span></td>
        <td title="${escapeHtml(formatDateRanges(s.dates))}${s.time ? " " + escapeHtml(s.time) : ""}">${escapeHtml(formatDateRangesShort(s.dates))}${s.time ? ` ${escapeHtml(s.time)}` : ""}</td>
        <td title="${escapeHtml(s.vendor || "")}">${escapeHtml(s.vendor || "-")}</td>
        <td title="${escapeHtml(responsibleLabel(respArr))}">${escapeHtml(responsibleShort(respArr))}</td>
        <td title="${escapeHtml(s.registeredBy || "")}">${escapeHtml(s.registeredBy || "-")}</td>
        <td class="td-del"><button type="button" class="row-delete-btn" title="삭제">🗑</button></td>
      `;
      tr.addEventListener("click", () => openScheduleEdit(s.id, true));
      const scheduleEditBtn = tr.querySelector(".row-edit-btn");
      if (scheduleEditBtn) scheduleEditBtn.addEventListener("click", (e) => { e.stopPropagation(); openScheduleEdit(s.id, false); });
      tr.querySelector(".row-check").addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.checked) selectedScheduleIds.add(s.id); else selectedScheduleIds.delete(s.id);
      });
      tr.querySelector(".row-delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        handleDeleteClick("schedule", s);
      });
      tbody.appendChild(tr);
    });
    if (!todayDividerShown) {
      const divider = document.createElement("tr");
      divider.style.cursor = "default";
      divider.innerHTML = `<td colspan="8" style="background:var(--bg); color:var(--ink-soft); font-weight:800; text-align:center; padding:7px; border-top:1px dashed var(--line-strong); border-bottom:1px dashed var(--line-strong);">오늘 (${today})</td>`;
      tbody.appendChild(divider);
    }
  });
}

document.getElementById("schedule-select-all").addEventListener("change", (e) => {
  if (e.target.checked) lastRenderedScheduleIds.forEach(id => selectedScheduleIds.add(id));
  else lastRenderedScheduleIds.forEach(id => selectedScheduleIds.delete(id));
  renderSchedules();
});
document.getElementById("schedule-bulk-delete").addEventListener("click", () => bulkDelete("schedule", schedules, selectedScheduleIds));

/* ── 일정관리: 월간보기 캘린더 ───────────────── */
let schedCalViewY, schedCalViewM;
{
  const t = new Date();
  schedCalViewY = t.getFullYear();
  schedCalViewM = t.getMonth();
}
/* 다음 날짜 iso 계산 (주 경계 넘어 이어지는 일정인지 판단용, board.html과 동일 로직) */
function addDaysIso(iso, delta) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return isoDate(d);
}
/* 일정별 고유 색조 자동 부여 (board.html과 동일 로직) - 같은 유형 안에서도 항목마다 살짝 다른 색조를 고정 배정 */
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function hexToHsl(hex) {
  hex = hex.replace("#", "");
  const r = parseInt(hex.substr(0,2),16)/255, g = parseInt(hex.substr(2,2),16)/255, b = parseInt(hex.substr(4,2),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b);
  let h, s; const l = (max+min)/2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h*360, s*100, l*100];
}
const SCHED_TYPE_VAR = { "공사": "--type-공사", "미팅": "--type-미팅", "업무": "--type-업무", "기타": "--type-기타" };
const schedColorCache = {};
function scheduleColorVariant(type, id) {
  const cacheKey = (type || "업무") + "|" + id;
  if (schedColorCache[cacheKey]) return schedColorCache[cacheKey];
  const baseHex = getComputedStyle(document.documentElement).getPropertyValue(SCHED_TYPE_VAR[type] || SCHED_TYPE_VAR["업무"]).trim();
  const [h, s, l] = hexToHsl(baseHex);
  const hash = hashStr(String(id || ""));
  const hueShift = (hash % 25) - 12;
  const lightShift = ((hash >> 5) % 14) - 7;
  const hue = (h + hueShift + 360) % 360;
  const fgL = Math.max(20, Math.min(45, l + lightShift));
  const bgL = Math.max(88, Math.min(96, 92 + lightShift / 2));
  const variant = {
    fg: `hsl(${hue.toFixed(0)}, ${s.toFixed(0)}%, ${fgL.toFixed(0)}%)`,
    bg: `hsl(${hue.toFixed(0)}, ${Math.max(20, s - 10).toFixed(0)}%, ${bgL.toFixed(0)}%)`
  };
  schedColorCache[cacheKey] = variant;
  return variant;
}
function renderScheduleCalendar() {
  document.getElementById("sched-cal-title").textContent = `${schedCalViewY}년 ${schedCalViewM + 1}월`;
  const firstDow = new Date(schedCalViewY, schedCalViewM, 1).getDay();
  const daysInMonth = new Date(schedCalViewY, schedCalViewM + 1, 0).getDate();
  const daysInPrevMonth = new Date(schedCalViewY, schedCalViewM, 0).getDate();
  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, other: true, y: schedCalViewM === 0 ? schedCalViewY - 1 : schedCalViewY, m: (schedCalViewM + 11) % 12 });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, other: false, y: schedCalViewY, m: schedCalViewM });
  while (cells.length % 7 !== 0) {
    const idx = cells.length - (firstDow + daysInMonth);
    cells.push({ day: idx + 1, other: true, y: schedCalViewM === 11 ? schedCalViewY + 1 : schedCalViewY, m: (schedCalViewM + 1) % 12 });
  }
  const todayIsoStr = todayIso();
  const grid = document.getElementById("sched-cal-grid");
  grid.innerHTML = "";

  for (let w = 0; w < cells.length / 7; w++) {
    const weekCells = cells.slice(w * 7, w * 7 + 7);
    const weekIsos = weekCells.map(c => isoDate(new Date(c.y, c.m, c.day)));

    const weekEl = document.createElement("div");
    weekEl.className = "cal-week";

    const daynumsEl = document.createElement("div");
    daynumsEl.className = "cal-daynums";
    weekCells.forEach((c, i) => {
      const iso = weekIsos[i];
      const dowIdx = new Date(c.y, c.m, c.day).getDay();
      const hName = holidayName(iso);
      const isRedDay = dowIdx === 0 || dowIdx === 6 || !!hName;
      const cell = document.createElement("div");
      cell.className = "day-cell" + (c.other ? " other-month" : "");
      const numWrap = document.createElement("div");
      numWrap.className = "day-num" + (isRedDay ? " is-redday" : "");
      let numHtml = iso === todayIsoStr ? `<span class="today-badge">${c.day}</span>` : `<span>${c.day}</span>`;
      if (hName) numHtml += `<span class="holiday-name" title="${escapeHtml(hName)}">${escapeHtml(hName)}</span>`;
      numWrap.innerHTML = numHtml;
      cell.appendChild(numWrap);
      daynumsEl.appendChild(cell);
    });
    weekEl.appendChild(daynumsEl);

    const segments = [];
    schedules.forEach(s => {
      if (!Array.isArray(s.dates)) return;
      let runStart = null;
      for (let col = 0; col <= 7; col++) {
        const has = col < 7 && s.dates.includes(weekIsos[col]);
        if (has && runStart === null) runStart = col;
        if (!has && runStart !== null) {
          segments.push({ s, startCol: runStart, endCol: col - 1 });
          runStart = null;
        }
      }
    });
    segments.sort((a, b) => a.startCol - b.startCol || (b.endCol - b.startCol) - (a.endCol - a.startCol));
    const lanes = [];
    segments.forEach(seg => {
      let laneIdx = lanes.findIndex(lane => lane.every(o => seg.startCol > o.endCol || seg.endCol < o.startCol));
      if (laneIdx === -1) { lanes.push([seg]); seg.lane = lanes.length - 1; }
      else { lanes[laneIdx].push(seg); seg.lane = laneIdx; }
    });

    if (lanes.length) {
      const lanesEl = document.createElement("div");
      lanesEl.className = "cal-lanes";
      const laneRows = lanes.map(() => {
        const r = document.createElement("div");
        r.className = "cal-lane";
        lanesEl.appendChild(r);
        return r;
      });
      segments.forEach(seg => {
        const bar = document.createElement("div");
        bar.className = "event-chip type-" + (seg.s.type || "업무");
        bar.style.gridColumn = `${seg.startCol + 1} / ${seg.endCol + 2}`;
        // 장기 연속일정은 업체 옆에 "07/15~07/23" 범위를 표시 (board.html과 동일)
        const rangeNote = seg.startCol !== seg.endCol ? `${mdShort(weekIsos[seg.startCol])}~${mdShort(weekIsos[seg.endCol])}` : "";
        const noteParts = [seg.s.vendor, rangeNote].filter(Boolean);
        const noteText = noteParts.length ? ` (${noteParts.join(" ")})` : "";
        // 주 경계를 넘어 이어지는 일정은 각진 모서리 + 화살표로 이어짐을 표시
        const contPrev = seg.startCol === 0 && Array.isArray(seg.s.dates) && seg.s.dates.includes(addDaysIso(weekIsos[0], -1));
        const contNext = seg.endCol === 6 && Array.isArray(seg.s.dates) && seg.s.dates.includes(addDaysIso(weekIsos[6], 1));
        bar.classList.toggle("cont-prev", contPrev);
        bar.classList.toggle("cont-next", contNext);
        bar.textContent = (contPrev ? "◀ " : "") + (seg.s.time ? seg.s.time + " " : "") + seg.s.title + noteText + (contNext ? " ▶" : "");
        // 일정별 고유 색조 부여 (같은 유형 안에서도 항목마다 구분되도록)
        const variant = scheduleColorVariant(seg.s.type, seg.s.id);
        bar.style.backgroundColor = variant.bg;
        bar.style.color = variant.fg;
        bar.style.borderLeftColor = variant.fg;
        bar.title = "클릭하면 상세보기가 열립니다";
        bar.addEventListener("click", (e) => {
          e.stopPropagation();
          openScheduleEdit(seg.s.id);
        });
        laneRows[seg.lane].appendChild(bar);
      });
      weekEl.appendChild(lanesEl);
    }

    grid.appendChild(weekEl);
  }
}
document.getElementById("sched-cal-prev").addEventListener("click", () => {
  schedCalViewM--; if (schedCalViewM < 0) { schedCalViewM = 11; schedCalViewY--; }
  renderScheduleCalendar();
});
document.getElementById("sched-cal-next").addEventListener("click", () => {
  schedCalViewM++; if (schedCalViewM > 11) { schedCalViewM = 0; schedCalViewY++; }
  renderScheduleCalendar();
});
document.getElementById("schedule-view-toggle").addEventListener("click", () => {
  scheduleViewMode = scheduleViewMode === "list" ? "calendar" : "list";
  const isCal = scheduleViewMode === "calendar";
  document.getElementById("schedule-calendar-view").style.display = isCal ? "block" : "none";
  document.getElementById("schedule-table").style.display = isCal ? "none" : "table";
  document.getElementById("schedule-view-toggle").innerHTML = isCal
    ? `<span class="nav-link-icon">📋</span> 목록보기`
    : `<span class="nav-link-icon">🗓️</span> 월간보기`;
  if (isCal) renderScheduleCalendar();
});

const scheduleOverlay = document.getElementById("schedule-modal-overlay");
let scheduleDateSet = new Set();
let scheduleEditingId = null;
let scheduleEditMode = false; // 지금 열려있는 일정 모달이 실제 수정모드인지(true) 열람모드인지(false)
let scheduleDetailUnsubscribe = null;
const scheduleDetailsById = new Map();

async function ensureScheduleDetailsMigrated(schedule) {
  if (schedule.detailsMigrated) return;
  if (!ownsRecord("schedule", schedule) && !isAdmin()) return;
  const legacy = (schedule.history && schedule.history.length)
    ? schedule.history
    : (schedule.detail ? [{ id:"legacy-0000", text:schedule.detail, author:schedule.registeredBy, timestamp:schedule.registeredAt }] : []);
  const batch = writeBatch(db);
  legacy.slice(0, 450).forEach((item, index) => {
    const id = item.id || `legacy-${String(index).padStart(4, "0")}`;
    batch.set(doc(db, "schedules", schedule.id, "details", id), {
      text: item.text || "", author: item.author || schedule.registeredBy || "-",
      authorUid: item.authorUid || null, createdAt: item.timestamp || schedule.registeredAt || serverTimestamp(),
      editedAt: item.editedAt || null, archived: false, migrated: true, schemaVersion: SCHEMA_VERSION
    }, { merge: true });
  });
  const last = legacy.length ? legacy[legacy.length - 1] : null;
  batch.update(doc(db, "schedules", schedule.id), {
    detailsMigrated:true, legacyHistoryArchived:true, history:[], detail:null, schemaVersion:SCHEMA_VERSION,
    ...(last ? { lastDetailText:last.text || "", lastDetailAuthor:last.author || schedule.registeredBy || "-", lastDetailAuthorUid:last.authorUid || memberUidByName.get(last.author) || null, lastDetailAt:last.timestamp || schedule.updatedAt || schedule.registeredAt || serverTimestamp() } : {})
  });
  await batch.commit();
}

function subscribeScheduleDetails(schedule) {
  if (scheduleDetailUnsubscribe) scheduleDetailUnsubscribe();
  ensureScheduleDetailsMigrated(schedule).catch(error => reportDataError("일정 이력 이전", error));
  scheduleDetailUnsubscribe = onSnapshot(
    query(collection(db, "schedules", schedule.id, "details"), orderBy("createdAt", "asc"), limit(200)),
    snap => {
      let rows = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(d => !d.archived);
      if (!rows.length && !schedule.detailsMigrated) {
        rows = (schedule.history && schedule.history.length) ? schedule.history
          : (schedule.detail ? [{ id:"legacy-0000", text:schedule.detail, author:schedule.registeredBy, timestamp:schedule.registeredAt }] : []);
      }
      scheduleDetailsById.set(schedule.id, rows);
      if (scheduleEditingId === schedule.id) renderScheduleHistory(schedule, rows);
    },
    error => reportDataError("일정 세부사항 불러오기", error)
  );
}

function addScheduleDetailToBatch(batch, scheduleId, text) {
  const detailRef = doc(collection(db, "schedules", scheduleId, "details"));
  batch.set(detailRef, {
    text, author:currentUser(), authorUid:currentUid(), createdAt:serverTimestamp(),
    editedAt:null, archived:false, schemaVersion:SCHEMA_VERSION
  });
  return detailRef;
}

/* 선택된 날짜들을 연속 구간별로 묶어서 반환 (기간으로 추가한 날짜들을 칩 하나로 압축 표시하기 위함) */
function scheduleDateGroups() {
  const sorted = [...scheduleDateSet].sort();
  const groups = [];
  if (!sorted.length) return groups;
  let start = sorted[0], prev = sorted[0], isos = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const prevDate = new Date(prev + "T00:00:00");
    prevDate.setDate(prevDate.getDate() + 1);
    if (d === isoDate(prevDate)) {
      prev = d; isos.push(d);
    } else {
      groups.push({ start, end: prev, isos });
      start = d; prev = d; isos = [d];
    }
  }
  groups.push({ start, end: prev, isos });
  return groups;
}

function renderDateChips() {
  const wrap = document.getElementById("schedule-date-chips");
  wrap.innerHTML = "";
  scheduleDateGroups().forEach(g => {
    const chip = document.createElement("div");
    chip.className = "date-chip";
    const label = g.start === g.end ? g.start : `${g.start} ~ ${g.end}`;
    chip.innerHTML = `<span>${label}</span><button type="button">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      g.isos.forEach(iso => scheduleDateSet.delete(iso));
      renderDateChips();
    });
    wrap.appendChild(chip);
  });
}

function setScheduleFieldsEditable(editable) {
  document.getElementById("schedule-edit-fields").style.display = editable ? "block" : "none";
  document.getElementById("schedule-view-fields").style.display = editable ? "none" : "block";
  scheduleResponsibleEditable = editable;
  renderResponsibleChecks();
}
/* 열람 모드일 때 축약된 고정 텍스트로 채워넣기 */
function renderScheduleViewSummary(s) {
  document.getElementById("sv-title").textContent = s.title || "-";
  document.getElementById("sv-type").textContent = typeLabel(s.type);
  document.getElementById("sv-vendor").textContent = s.vendor || "-";
  document.getElementById("sv-responsible").textContent = responsibleLabel(responsibleArray(s));
  document.getElementById("sv-dates").textContent = formatDateRanges(s.dates) + (s.time ? ` ${s.time}` : "");
}

document.getElementById("schedule-add-range").addEventListener("click", () => {
  const start = document.getElementById("schedule-range-start").value;
  const end = document.getElementById("schedule-range-end").value;
  if (!dpParse(start) || !dpParse(end) || start > end) { alert("시작일과 종료일을 올바르게 입력하세요 (YYYY-MM-DD)"); return; }
  let cur = new Date(start + "T00:00:00");
  const endD = new Date(end + "T00:00:00");
  while (cur <= endD) {
    scheduleDateSet.add(isoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  renderDateChips();
});
document.getElementById("schedule-add-single").addEventListener("click", () => {
  const v = document.getElementById("schedule-single-date").value;
  if (!dpParse(v)) { alert("날짜를 올바르게 입력하세요 (YYYY-MM-DD)"); return; }
  scheduleDateSet.add(v);
  renderDateChips();
});

function openScheduleNew() {
  scheduleEditingId = null;
  scheduleEditMode = true;
  document.getElementById("schedule-modal-title").textContent = "새 일정 등록";
  document.getElementById("schedule-readonly-note").style.display = "none";
  document.getElementById("schedule-title").value = "";
  document.getElementById("schedule-type").value = "공사";
  document.getElementById("schedule-vendor").value = "";
  document.getElementById("schedule-time").value = "";
  document.getElementById("schedule-range-start").value = "";
  document.getElementById("schedule-range-end").value = "";
  document.getElementById("schedule-single-date").value = "";
  scheduleDateSet = new Set();
  renderDateChips();
  scheduleResponsibleSet = new Set([currentUser()]);
  renderResponsibleChecks();
  document.getElementById("schedule-registrar-display").textContent = currentUser();
  document.getElementById("schedule-delete").style.display = "none";
  setScheduleFieldsEditable(true);
  document.getElementById("schedule-history-field").style.display = "none";
  document.getElementById("schedule-detail-label").textContent = "세부사항";
  document.getElementById("schedule-detail-input").value = "";
  scheduleOverlay.classList.add("open");
}
document.getElementById("schedule-new-btn").addEventListener("click", openScheduleNew);

/* forceView === true 이면 작성자 여부와 관계없이 항상 열람(읽기전용) 모드로 연다.
   forceView가 없으면(=제목 옆 [edit] 아이콘/캘린더뷰/대시보드 등 기존 진입경로) 작성자 본인일 때만 수정 가능 */
function openScheduleEdit(id, forceView) {
  const s = schedules.find(x => x.id === id);
  if (!s) return;
  scheduleEditingId = id;
  const isAuthor = ownsRecord("schedule", s) || isAdmin();
  const editMode = forceView ? false : isAuthor;
  scheduleEditMode = editMode;
  document.getElementById("schedule-modal-title").textContent = "일정 " + (editMode ? "수정" : "열람");
  document.getElementById("schedule-readonly-note").textContent = isAuthor
    ? "제목 옆 편집 아이콘(✏️)을 클릭하면 수정할 수 있습니다."
    : "작성자만 위 항목들을 수정할 수 있습니다. 추가사항은 누구나 남길 수 있습니다.";
  document.getElementById("schedule-readonly-note").style.display = editMode ? "none" : "block";
  document.getElementById("schedule-title").value = s.title || "";
  document.getElementById("schedule-type").value = s.type || "공사";
  document.getElementById("schedule-vendor").value = s.vendor || "";
  document.getElementById("schedule-time").value = s.time || "";
  document.getElementById("schedule-range-start").value = "";
  document.getElementById("schedule-range-end").value = "";
  document.getElementById("schedule-single-date").value = "";
  scheduleDateSet = new Set(s.dates || []);
  renderDateChips();
  scheduleResponsibleSet = new Set(responsibleArray(s));
  renderResponsibleChecks();
  renderScheduleViewSummary(s);
  document.getElementById("schedule-registrar-display").textContent = s.registeredBy || "-";
  document.getElementById("schedule-delete").style.display = "inline-block";
  setScheduleFieldsEditable(editMode);

  const hist = scheduleDetailsById.get(s.id) || ((s.history && s.history.length) ? s.history
    : (s.detail ? [{ text: s.detail, author: s.registeredBy, timestamp: s.registeredAt }] : []));
  try {
    renderScheduleHistory(s, hist);
  } catch (e) {
    console.error("세부사항 렌더링 오류", e);
    document.getElementById("schedule-history-list").innerHTML = `<div class="small-note">세부사항을 표시하는 중 오류가 발생했습니다</div>`;
  }
  document.getElementById("schedule-history-field").style.display = "block";
  document.getElementById("schedule-detail-label").textContent = "추가사항";
  document.getElementById("schedule-detail-input").value = "";

  scheduleOverlay.classList.add("open");
  subscribeScheduleDetails(s);
  markSeen("schedule", id);
}

/* 일정 세부사항/추가사항 목록: 시간순(오래된 것이 위) + 댓글(답글) + 읽음 이력 */
function renderScheduleHistory(s, hist) {
  const histEl = document.getElementById("schedule-history-list");
  histEl.innerHTML = "";
  if (!hist.length) { histEl.innerHTML = `<div class="small-note">이력이 없습니다</div>`; return; }
  const candidates = [s.registeredBy, ...responsibleArray(s)];

  /* 댓글(답글) 기능은 제거하고, 한 일정에 대한 모든 세부사항/추가사항을 시간순(오래된 것이 위)
     하나의 트리(목록)로 이어서 보여줌 - 계속 업데이트하거나 의견을 더하는 용도이므로 단순한 목록이 더 직관적 */
  hist.forEach(h => {
    const div = document.createElement("div");
    div.className = "history-item";
    const readBy = h.id ? noteReadBy(s, h, candidates) : [];
    const readNote = readBy.length ? `<div class="small-note">읽음: ${readBy.map(escapeHtml).join(", ")}</div>` : "";
    div.innerHTML = `<div class="meta">${escapeHtml(h.author || "-")} · ${fmtTs(h.createdAt || h.timestamp)}${h.editedAt ? " (수정됨)" : ""}</div><div>${escapeHtml(h.text)}</div>${readNote}`;
    if (h.id && scheduleEditingId !== null) {
      // 본인이 쓴 세부사항은 수정·삭제 가능. 관리자 계정은 예외 없이 전부 수정/삭제 가능
      const canModify = isAdmin() || (h.authorUid ? h.authorUid === currentUid() : h.author === currentUser());
      if (canModify) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn-secondary";
        editBtn.style.cssText = "padding:3px 10px; font-size:12.5px; margin-top:6px; margin-right:6px;";
        editBtn.textContent = "수정";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn-secondary btn-danger-outline";
        delBtn.style.cssText = "padding:3px 10px; font-size:12.5px; margin-top:6px; margin-right:6px;";
        delBtn.textContent = "삭제";
        const editBox = document.createElement("div");
        editBox.style.cssText = "display:none; margin-top:8px; gap:6px; flex-direction:column;";
        const editTa = document.createElement("textarea");
        editTa.value = h.text;
        editTa.style.cssText = "min-height:50px;";
        const editSaveBtn = document.createElement("button");
        editSaveBtn.type = "button";
        editSaveBtn.className = "btn-primary";
        editSaveBtn.style.cssText = "padding:6px 14px; font-size:13px; align-self:flex-end;";
        editSaveBtn.textContent = "저장";
        editBtn.addEventListener("click", () => {
          editBox.style.display = editBox.style.display === "none" ? "flex" : "none";
        });
        editSaveBtn.addEventListener("click", async () => {
          const txt = editTa.value.trim();
          if (!txt) { alert("내용을 입력하세요"); return; }
          await editScheduleNote(h.id, txt);
        });
        editBox.appendChild(editTa);
        editBox.appendChild(editSaveBtn);
        delBtn.addEventListener("click", async () => {
          if (!confirm("이 항목을 삭제할까요?")) return;
          await deleteScheduleNote(h.id);
        });
        div.appendChild(editBtn);
        div.appendChild(delBtn);
        div.appendChild(editBox);
      }
    }
    histEl.appendChild(div);
  });
}

/* 본인이 쓴 세부사항/댓글 수정 (댓글이 달린 세부사항은 renderEntry 단계에서 애초에 버튼을 노출하지 않음) */
async function editScheduleNote(id, text) {
  if (scheduleEditingId === null) return;
  const s = schedules.find(x => x.id === scheduleEditingId);
  if (!s) return;
  await updateDoc(doc(db, "schedules", scheduleEditingId, "details", id), { text, editedAt:serverTimestamp() });
  await updateDoc(doc(db, "schedules", scheduleEditingId), { lastDetailText:text, lastDetailAuthor:currentUser(), lastDetailAt:serverTimestamp(), updatedAt:serverTimestamp() });
}

/* 본인이 쓴 세부사항/댓글 삭제 */
async function deleteScheduleNote(id) {
  if (scheduleEditingId === null) return;
  const s = schedules.find(x => x.id === scheduleEditingId);
  if (!s) return;
  await updateDoc(doc(db, "schedules", scheduleEditingId, "details", id), { archived:true, archivedAt:serverTimestamp(), archivedBy:currentUser(), archivedByUid:currentUid() });
  await updateDoc(doc(db, "schedules", scheduleEditingId), { updatedAt: serverTimestamp() });
}

document.getElementById("schedule-cancel").addEventListener("click", () => scheduleOverlay.classList.remove("open"));

document.getElementById("schedule-save").addEventListener("click", async () => {
  const orig = scheduleEditingId !== null ? schedules.find(x => x.id === scheduleEditingId) : null;
  const noteText = document.getElementById("schedule-detail-input").value.trim();

  if (orig && !scheduleEditMode) {
    if (!noteText) { alert("추가할 내용을 입력하세요"); return; }
    const batch = writeBatch(db);
    addScheduleDetailToBatch(batch, scheduleEditingId, noteText);
    batch.update(doc(db, "schedules", scheduleEditingId), {
      lastDetailText:noteText, lastDetailAuthor:currentUser(), lastDetailAuthorUid:currentUid(),
      lastDetailAt:serverTimestamp(), updatedAt:serverTimestamp(), detailsMigrated:true
    });
    addAuditToBatch(batch, "schedule", scheduleEditingId, "detail_added", null, { author:currentUser() });
    await batch.commit();
    scheduleOverlay.classList.remove("open");
    return;
  }

  const title = document.getElementById("schedule-title").value.trim();
  if (!title) { alert("제목을 입력하세요"); return; }
  if (scheduleDateSet.size === 0) { alert("날짜를 1개 이상 추가하세요"); return; }
  const payload = {
    title,
    type: document.getElementById("schedule-type").value,
    vendor: document.getElementById("schedule-vendor").value.trim(),
    time: document.getElementById("schedule-time").value || null,
    responsible: [...scheduleResponsibleSet],
    responsibleUids: [...scheduleResponsibleSet].map(name => memberUidByName.get(name)).filter(Boolean),
    dates: [...scheduleDateSet],
    months: monthKeysForDates([...scheduleDateSet]),
    schemaVersion: SCHEMA_VERSION,
    updatedAt: serverTimestamp()
  };
  const scheduleRef = scheduleEditingId === null ? doc(collection(db, "schedules")) : doc(db, "schedules", scheduleEditingId);
  const batch = writeBatch(db);
  if (scheduleEditingId === null) {
    payload.registeredBy = currentUser();
    payload.registeredByUid = currentUid();
    payload.registeredAt = serverTimestamp();
    payload.archived = false;
    payload.detailsMigrated = true;
    if (noteText) Object.assign(payload, { lastDetailText:noteText, lastDetailAuthor:currentUser(), lastDetailAuthorUid:currentUid(), lastDetailAt:serverTimestamp() });
    batch.set(scheduleRef, payload);
    addAuditToBatch(batch, "schedule", scheduleRef.id, "schedule_created", null, { title, dates:payload.dates });
  } else {
    payload.registeredBy = orig.registeredBy;
    payload.registeredByUid = orig.registeredByUid || memberUidByName.get(orig.registeredBy) || currentUid();
    if (noteText) Object.assign(payload, { lastDetailText:noteText, lastDetailAuthor:currentUser(), lastDetailAuthorUid:currentUid(), lastDetailAt:serverTimestamp() });
    batch.update(scheduleRef, payload);
    addAuditToBatch(batch, "schedule", scheduleRef.id, "schedule_updated", { title:orig.title, dates:orig.dates }, { title, dates:payload.dates });
  }
  if (noteText) addScheduleDetailToBatch(batch, scheduleRef.id, noteText);
  await batch.commit();
  showToast("일정이 저장되었습니다");
  scheduleOverlay.classList.remove("open");
});

document.getElementById("schedule-delete").addEventListener("click", async () => {
  if (!scheduleEditingId) return;
  const s = schedules.find(x => x.id === scheduleEditingId);
  if (!s) return;
  const done = await handleDeleteClick("schedule", s);
  if (done) scheduleOverlay.classList.remove("open");
});

/* ════════════════════════════════════════════════
   3. 메모
   ════════════════════════════════════════════════ */
let memos = [];
let selectedMemoIds = new Set();
let lastRenderedMemoIds = [];
let memoAssigneeSet = new Set();

function renderMemoAssigneeChecks() {
  const wrap = document.getElementById("memo-assignee-checks");
  wrap.innerHTML = "";
  const allSelected = TEAM_MEMBERS.length > 0 && TEAM_MEMBERS.every(name => memoAssigneeSet.has(name));
  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "resp-chip" + (allSelected ? " active" : "");
  allChip.textContent = "전체";
  allChip.setAttribute("aria-pressed", String(allSelected));
  allChip.addEventListener("click", () => {
    memoAssigneeSet = allSelected ? new Set() : new Set(TEAM_MEMBERS);
    renderMemoAssigneeChecks();
  });
  wrap.appendChild(allChip);
  TEAM_MEMBERS.forEach(name => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "resp-chip" + (memoAssigneeSet.has(name) ? " active" : "");
    chip.textContent = name;
    chip.setAttribute("aria-pressed", String(memoAssigneeSet.has(name)));
    chip.addEventListener("click", () => {
      if (memoAssigneeSet.has(name)) memoAssigneeSet.delete(name);
      else memoAssigneeSet.add(name);
      renderMemoAssigneeChecks();
    });
    wrap.appendChild(chip);
  });
}
onSnapshot(query(collection(db, "phoneMemos"), orderBy("receivedAt", "desc"), limit(500)), (snap) => {
  memos = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => !m.archived);
  renderMemos();
  renderDashboard();
}, error => reportDataError("메모 불러오기", error));
document.getElementById("memo-filter-status").addEventListener("change", renderMemos);

function renderMemos() {
  const f = document.getElementById("memo-filter-status").value;
  const rows = memos.filter(m => f === "all" || m.status === f);
  lastRenderedMemoIds = rows.map(m => m.id);
  const tbody = document.getElementById("memo-tbody");
  tbody.innerHTML = "";
  const me = currentUser();
  const groups = [
    { label:"내 관련 메모", kind:"mine", items:rows.filter(m => m.assignee === me || m.receivedBy === me) },
    { label:"시설팀 공유 메모", kind:"team", items:rows.filter(m => m.assignee !== me && m.receivedBy !== me) }
  ];

  groups.forEach(group => {
    appendFocusGroupHeader(tbody, group.label, group.items.length, group.kind, 7);
    if (!group.items.length) {
      const empty = document.createElement("tr");
      empty.className = "focus-group-empty";
      empty.innerHTML = `<td colspan="7">해당 메모가 없습니다</td>`;
      tbody.appendChild(empty);
      return;
    }
    group.items.forEach(m => {
      const tr = document.createElement("tr");
      if (m.status === "확인됨" && me === m.assignee) tr.classList.add("row-emphasized");
      else if (m.status === "확인됨" && me === m.receivedBy) tr.classList.add("row-dimmed");
      tr.innerHTML = `
        <td class="td-check"><input type="checkbox" class="row-check" ${selectedMemoIds.has(m.id) ? "checked" : ""} /></td>
        <td><b>${escapeHtml(m.assignee || "미지정")}</b> - ${escapeHtml(m.subject || "")}${deleteRequestBadge(m)}</td>
        <td><span class="badge urgency-${m.urgency}">${escapeHtml(m.urgency || "-")}</span></td>
        <td>${escapeHtml(m.receivedBy || "-")}</td>
        <td>${fmtTs(m.receivedAt)}</td>
        <td><span class="badge status-${m.status}">${escapeHtml(m.status || "-")}</span>${m.status === "확인됨" ? `<div class="small-note">${escapeHtml(m.confirmedBy || "-")} ${fmtTs(m.confirmedAt)}</div>` : ""}</td>
        <td class="td-del"><button type="button" class="row-delete-btn" title="삭제">🗑</button></td>
      `;
      tr.addEventListener("click", () => openMemoEdit(m.id));
      tr.querySelector(".row-check").addEventListener("click", (e) => {
        e.stopPropagation();
        if (e.target.checked) selectedMemoIds.add(m.id); else selectedMemoIds.delete(m.id);
      });
      tr.querySelector(".row-delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        handleDeleteClick("memo", m);
      });
      tbody.appendChild(tr);
    });
  });
}

document.getElementById("memo-select-all").addEventListener("change", (e) => {
  if (e.target.checked) lastRenderedMemoIds.forEach(id => selectedMemoIds.add(id));
  else lastRenderedMemoIds.forEach(id => selectedMemoIds.delete(id));
  renderMemos();
});
document.getElementById("memo-bulk-delete").addEventListener("click", () => bulkDelete("memo", memos, selectedMemoIds));

const memoOverlay = document.getElementById("memo-modal-overlay");
let memoEditingId = null;
let memoEditFull = false;

function nowLocalDatetimeValue() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0,16);
}

document.getElementById("memo-new-btn").addEventListener("click", () => {
  memoEditingId = null;
  memoEditFull = true;
  document.getElementById("memo-modal-title").textContent = "새 메모 등록";
  fillNameSelect(document.getElementById("memo-receiver"), currentUser());
  const defaultAssignee = TEAM_MEMBERS.includes("강보선") ? "강보선" : currentUser();
  memoAssigneeSet = new Set([defaultAssignee]);
  document.getElementById("memo-assignee").style.display = "none";
  document.getElementById("memo-assignee-multi").style.display = "block";
  renderMemoAssigneeChecks();
  document.getElementById("memo-subject").value = "";
  document.getElementById("memo-urgency").value = "중";
  document.getElementById("memo-time").value = nowLocalDatetimeValue();
  document.getElementById("memo-status-field").style.display = "none";
  document.getElementById("memo-delete").style.display = "none";
  document.getElementById("memo-save").style.display = "inline-block";
  ["memo-receiver", "memo-assignee", "memo-subject", "memo-urgency", "memo-time"].forEach(fieldId => { document.getElementById(fieldId).disabled = false; });
  document.getElementById("memo-status-select").disabled = false;
  memoOverlay.classList.add("open");
});

function openMemoEdit(id) {
  const m = memos.find(x => x.id === id);
  if (!m) return;
  memoEditingId = id;
  memoEditFull = ownsRecord("memo", m) || isAdmin();
  document.getElementById("memo-modal-title").textContent = "메모 수정";
  fillNameSelect(document.getElementById("memo-receiver"), m.receivedBy);
  fillNameSelect(document.getElementById("memo-assignee"), m.assignee);
  document.getElementById("memo-assignee").style.display = "block";
  document.getElementById("memo-assignee-multi").style.display = "none";
  document.getElementById("memo-subject").value = m.subject || "";
  document.getElementById("memo-urgency").value = m.urgency || "중";
  const d = m.receivedAt?.toDate ? m.receivedAt.toDate() : new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  document.getElementById("memo-time").value = local.toISOString().slice(0,16);
  document.getElementById("memo-status-field").style.display = "block";
  document.getElementById("memo-status-select").value = m.status || "미확인";
  document.getElementById("memo-delete").style.display = "inline-block";
  ["memo-receiver", "memo-assignee", "memo-subject", "memo-urgency", "memo-time"].forEach(fieldId => {
    document.getElementById(fieldId).disabled = !memoEditFull;
  });
  document.getElementById("memo-status-select").disabled = !(memoEditFull || m.assignee === currentUser());
  document.getElementById("memo-save").style.display = (memoEditFull || m.assignee === currentUser()) ? "inline-block" : "none";
  memoOverlay.classList.add("open");
}

document.getElementById("memo-cancel").addEventListener("click", () => memoOverlay.classList.remove("open"));

document.getElementById("memo-delete").addEventListener("click", async () => {
  if (memoEditingId === null) return;
  const m = memos.find(x => x.id === memoEditingId);
  if (!m) return;
  const done = await handleDeleteClick("memo", m);
  if (done) memoOverlay.classList.remove("open");
});

document.getElementById("memo-save").addEventListener("click", async () => {
  const subject = document.getElementById("memo-subject").value.trim();
  if (!subject) { alert("용건을 입력하세요"); return; }
  const timeVal = document.getElementById("memo-time").value;
  const receivedAt = timeVal ? new Date(timeVal) : new Date();

  if (memoEditingId === null) {
    const assignees = TEAM_MEMBERS.filter(name => memoAssigneeSet.has(name));
    if (!assignees.length) { alert("담당자를 한 명 이상 선택하세요"); return; }
    const batch = writeBatch(db);
    const broadcastId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    assignees.forEach(assignee => {
      batch.set(doc(collection(db, "phoneMemos")), {
        receivedBy: document.getElementById("memo-receiver").value,
        createdByName: currentUser(),
        createdByUid: currentUid(),
        assignee,
        assigneeUid:memberUidByName.get(assignee) || null,
        subject,
        urgency: document.getElementById("memo-urgency").value,
        receivedAt,
        status: "미확인",
        confirmedBy: null,
        confirmedAt: null,
        broadcastId,
        broadcastRecipients: assignees,
        archived: false,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: serverTimestamp()
      });
    });
    await batch.commit();
  } else {
    const newStatus = document.getElementById("memo-status-select").value;
    const m = memos.find(x => x.id === memoEditingId);
    const payload = memoEditFull ? {
      receivedBy: document.getElementById("memo-receiver").value,
      assignee: document.getElementById("memo-assignee").value,
      assigneeUid:memberUidByName.get(document.getElementById("memo-assignee").value) || null,
      subject, urgency: document.getElementById("memo-urgency").value, receivedAt,
      status:newStatus, updatedAt:serverTimestamp()
    } : { status:newStatus, updatedAt:serverTimestamp() };
    if (newStatus === "확인됨" && m.status !== "확인됨") {
      payload.confirmedBy = currentUser();
      payload.confirmedAt = new Date();
    }
    if (newStatus === "미확인") {
      payload.confirmedBy = null;
      payload.confirmedAt = null;
    }
    await updateDoc(doc(db, "phoneMemos", memoEditingId), payload);
  }
  memoOverlay.classList.remove("open");
});

/* ════════════════════════════════════════════════
   0. 대시보드 렌더링
   ════════════════════════════════════════════════ */
let dashPastShowCount = 3; // 지난 일정 기본 표시 개수 (더보기/줄이기로 조절)
function daysDiffIso(a, b) {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  return Math.round((db - da) / 86400000);
}
let userNotifications = [];
const notificationBuckets = new Map();
function subscribeNotificationOwner(ownerKey) {
  onSnapshot(query(collection(db, "userNotifications", ownerKey, "items"), orderBy("createdAt", "desc"), limit(50)), snap => {
    notificationBuckets.set(ownerKey, snap.docs.map(d => ({ id:d.id, _ownerKey:ownerKey, ...d.data() })));
    userNotifications = [...notificationBuckets.values()].flat().sort((a, b) => tsMillis(b.createdAt) - tsMillis(a.createdAt)).slice(0, 50);
    renderDashboard();
  }, error => reportDataError("알림 불러오기", error));
}
[...new Set([currentUid(), currentUser()])].forEach(subscribeNotificationOwner);

let dashboardActivityExpanded = false;
document.getElementById("dash-activity-toggle").addEventListener("click", () => {
  dashboardActivityExpanded = !dashboardActivityExpanded;
  renderDashboard();
});

function activityChangePart(text, fallback = "내용") {
  const value = String(text || "");
  const parts = [];
  if (/새 업무 등록|등록$/.test(value)) parts.push("신규 등록");
  if (/상태|열람|접수|진행|보류|완료|재개/.test(value)) parts.push("진행상태");
  if (/구성원|수신자|담당자/.test(value)) parts.push("구성원");
  if (/기한|날짜/.test(value)) parts.push("일정·기한");
  if (/삭제/.test(value)) parts.push("삭제");
  return [...new Set(parts)].join("·") || fallback;
}

function renderDashboard() {
  const me = currentUser();

  /* 업데이트 알림 (이력/상세내용이 갱신되어 나에게 알려야 하는 항목) */
  const pendingUpdates = userNotifications.filter(n => !n.readAt).map(n => ({ type: "ticket", notification: n, rec: tickets.find(t => t.id === n.ticketId), label: tickets.find(t => t.id === n.ticketId)?.title || "관련업무" }));
  schedules.forEach(s => {
    if (notifyTargets("schedule", s).includes(me)) {
      const seen = s.lastSeenBy && s.lastSeenBy[me];
      if (!seen || seen < updatedMillis(s)) pendingUpdates.push({ type: "schedule", rec: s, label: s.title });
    }
  });
  /* 삭제 승인 대기 (내가 작성자인 항목에 다른 사람이 삭제를 요청한 경우) */
  const pendingDeletes = [];
  tickets.forEach(t => { if (t.deleteRequestedBy && t.requestedBy === me) pendingDeletes.push({ type: "ticket", rec: t, label: t.title }); });
  schedules.forEach(s => { if (s.deleteRequestedBy && s.registeredBy === me) pendingDeletes.push({ type: "schedule", rec: s, label: s.title }); });
  memos.forEach(m => { if (m.deleteRequestedBy && m.receivedBy === me) pendingDeletes.push({ type: "memo", rec: m, label: m.subject }); });
  const pendingMemoAlerts = memos.filter(m => m.assignee === me && m.status !== "확인됨");

  const alertList = document.getElementById("dash-alert-list");
  const alertCount = pendingUpdates.length + pendingDeletes.length + pendingMemoAlerts.length;
  document.getElementById("dash-alert-count").textContent = alertCount;
  alertList.innerHTML = "";
  pendingUpdates.forEach(({ type, rec, label, notification }) => {
    const writer = notification ? notification.actor : lastHistoryAuthor(rec);
    const lastText = notification ? notification.message : ((rec?.history && rec.history.length) ? rec.history[rec.history.length - 1].text : "업데이트");
    const div = document.createElement("div");
    div.className = "dash-card dash-update-card";
    div.style.cursor = "default";
    div.innerHTML = `
      <div class="dash-update-body">
        <div class="dc-title"><span class="attention-badge">미확인</span> [${LABEL_OF[type]}] ${escapeHtml(label || "항목")}</div>
        <div class="dc-meta">${escapeHtml(writer || "-")}님이 업데이트: ${escapeHtml(lastText)}</div>
      </div>
      <button type="button" class="dash-confirm-btn">확인</button>`;
    div.querySelector(".dash-confirm-btn").addEventListener("click", async () => {
      if (notification) await updateDoc(doc(db, "userNotifications", notification._ownerKey || notificationOwnerKey(me), "items", notification.id), { readAt: serverTimestamp() });
      else if (rec) await markSeen(type, rec.id);
      renderDashboard();
    });
    alertList.appendChild(div);
  });
  pendingDeletes.forEach(({ type, rec, label }) => {
      const div = document.createElement("div");
      div.className = "dash-card dash-update-card";
      div.style.cursor = "default";
      div.innerHTML = `<div class="dash-update-body"><div class="dc-title"><span class="attention-badge">승인 필요</span> [${LABEL_OF[type]}] ${escapeHtml(label || "항목")}</div>
        <div class="dc-meta">${escapeHtml(rec.deleteRequestedBy)}님이 삭제를 요청했습니다 · ${fmtTs(rec.deleteRequestedAt)}</div></div>`;
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex; gap:8px; margin-top:8px;";
      const approveBtn = document.createElement("button");
      approveBtn.type = "button"; approveBtn.className = "btn-primary";
      approveBtn.style.cssText = "padding:6px 12px; font-size:12.5px;";
      approveBtn.textContent = "삭제 동의";
      approveBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm("삭제에 동의하시겠습니까? 되돌릴 수 없습니다.")) await approveDelete(type, rec.id);
      });
      const denyBtn = document.createElement("button");
      denyBtn.type = "button"; denyBtn.className = "btn-secondary";
      denyBtn.style.cssText = "padding:6px 12px; font-size:12.5px;";
      denyBtn.textContent = "거절";
      denyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await denyDelete(type, rec.id);
      });
      btnRow.appendChild(approveBtn);
      btnRow.appendChild(denyBtn);
      div.querySelector(".dash-update-body").appendChild(btnRow);
      alertList.appendChild(div);
  });
  pendingMemoAlerts.forEach(memo => {
    const div = document.createElement("div");
    div.className = "dash-card dash-update-card";
    div.style.cursor = "default";
    div.innerHTML = `<div class="dash-update-body"><div class="dc-title"><span class="attention-badge">${memo.urgency === "상" ? "긴급" : "미확인"}</span> [메모] ${escapeHtml(memo.subject || "메모")}</div>
      <div class="dc-meta">작성자 ${escapeHtml(memo.receivedBy || "-")} · ${fmtTs(memo.receivedAt)}</div></div>
      <button type="button" class="dash-confirm-btn">내용 보기</button>`;
    div.querySelector("button").addEventListener("click", () => openMemoEdit(memo.id));
    alertList.appendChild(div);
  });
  if (!alertCount) alertList.innerHTML = `<div class="dash-empty">확인이 필요한 알림이 없습니다</div>`;

  const today = todayIso();
  const myTickets = isAdmin() ? tickets.slice() : tickets.filter(t => {
    const recipients = ticketRecipients(t);
    return t.requestedBy === me || (recipients.length ? recipients.includes(me) : t.requestedBy !== me);
  });
  const activeTickets = myTickets.filter(t => t.status !== "완료");
  const attentionTickets = activeTickets.filter(t => {
    const days = t.dueDate ? daysDiffIso(today, t.dueDate) : null;
    return (days !== null && days <= 3) || ["진행중", "보류"].includes(normalizedTicketStatus(t.status));
  }).sort((a, b) => {
    const ad = a.dueDate ? daysDiffIso(today, a.dueDate) : 99999;
    const bd = b.dueDate ? daysDiffIso(today, b.dueDate) : 99999;
    return ad - bd || updatedMillis(b) - updatedMillis(a);
  });
  const tEl = document.getElementById("dash-ticket-list");
  document.getElementById("dash-ticket-count").textContent = attentionTickets.length;
  tEl.innerHTML = "";
  if (!attentionTickets.length) {
    tEl.innerHTML = `<div class="dash-empty">오늘 또는 3일 이내 처리할 업무가 없습니다</div>`;
  } else {
    attentionTickets.slice(0, 5).forEach(t => {
      const days = t.dueDate ? daysDiffIso(today, t.dueDate) : null;
      const dueText = days === null ? "기한 없음" : days < 0 ? `기한초과 ${Math.abs(days)}일` : days === 0 ? "오늘" : `D-${days}`;
      const dueClass = days !== null && days < 0 ? "due-overdue" : days === 0 ? "due-today" : "";
      const div = document.createElement("div");
      div.className = "dash-card";
      div.innerHTML = `<div class="dc-title"><span class="${dueClass}">[${dueText}]</span> ${escapeHtml(t.title)} <span class="badge ${normalizedTicketStatus(t.status)}">${normalizedTicketStatus(t.status)}</span></div>
        <div class="dc-meta">${t.requestedBy === me ? "구성원 " + escapeHtml(ticketRecipientLabel(t)) : "요청 " + escapeHtml(t.requestedBy || "-")} · ${t.dueDate || "기한 미지정"}</div>`;
      div.addEventListener("click", () => { openTicketDetail(t.id); });
      tEl.appendChild(div);
    });
    if (attentionTickets.length > 5) tEl.insertAdjacentHTML("beforeend", `<div class="small-note" style="text-align:center;">외 ${attentionTickets.length - 5}건 · 제목을 눌러 관련업무 전체보기</div>`);
  }

  const mySchedules = schedules.filter(s => s.registeredBy === me || responsibleArray(s).includes(me));
  const sEl = document.getElementById("dash-schedule-list");
  sEl.innerHTML = "";
  if (!mySchedules.length) {
    document.getElementById("dash-schedule-count").textContent = "0";
    sEl.innerHTML = `<div class="dash-empty">관련 일정·공사가 없습니다</div>`;
  } else {
    const nearestUpcoming = (s) => [...new Set(s.dates || [])].sort().find(d => d >= today);
    const todaySchedules = [];
    const futureSchedules = [];
    const pastSchedules = [];
    mySchedules.forEach(s => {
      const dates = Array.isArray(s.dates) ? s.dates : [];
      if (dates.includes(today)) { todaySchedules.push(s); return; }
      const nu = nearestUpcoming(s);
      if (nu) futureSchedules.push({ s, nearest: nu });
      else pastSchedules.push(s);
    });
    futureSchedules.sort((a, b) => a.nearest < b.nearest ? -1 : a.nearest > b.nearest ? 1 : 0);
    todaySchedules.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99"));
    const upcomingCount = todaySchedules.length + futureSchedules.length;
    document.getElementById("dash-schedule-count").textContent = upcomingCount;
    let renderedScheduleCount = 0;
    if (!upcomingCount) sEl.innerHTML = `<div class="dash-empty">오늘 또는 다가오는 일정이 없습니다</div>`;

    /* Premium Timeline: 오늘 일정 */
    if (todaySchedules.length) {
      todaySchedules.slice(0, 5).forEach(s => {
        const div = document.createElement("div");
        div.className = `timeline-item type-${s.type || "업무"}`;
        div.innerHTML = `
          <span class="timeline-dday" style="color: var(--today); background: var(--today-bg);">오늘</span>
          <div class="timeline-title">${escapeHtml(s.title)}</div>
          <div class="timeline-meta">
            <span>${escapeHtml(typeLabel(s.type))}</span>
            <span>${formatDateRanges(s.dates)}${s.time ? " " + escapeHtml(s.time) : ""}</span>
            <span>담당: ${escapeHtml(responsibleLabel(responsibleArray(s)))}</span>
          </div>
        `;
        div.addEventListener("click", () => { openScheduleEdit(s.id); });
        sEl.appendChild(div);
        renderedScheduleCount++;
      });
    }

    /* Premium Timeline: 다가오는 일정 */
    futureSchedules.slice(0, Math.max(0, 5 - renderedScheduleCount)).forEach(({ s, nearest }) => {
      const dday = daysDiffIso(today, nearest);
      const div = document.createElement("div");
      div.className = `timeline-item type-${s.type || "업무"}`;
      div.innerHTML = `
        <span class="timeline-dday">D-${dday}</span>
        <div class="timeline-title">${escapeHtml(s.title)}</div>
        <div class="timeline-meta">
          <span>${escapeHtml(typeLabel(s.type))}</span>
          <span>${formatDateRanges(s.dates)}${s.time ? " " + escapeHtml(s.time) : ""}</span>
          <span>담당: ${escapeHtml(responsibleLabel(responsibleArray(s)))}</span>
        </div>
      `;
      div.addEventListener("click", () => { openScheduleEdit(s.id); });
      sEl.appendChild(div);
      renderedScheduleCount++;
    });
    if (upcomingCount > renderedScheduleCount) sEl.insertAdjacentHTML("beforeend", `<div class="small-note" style="text-align:center;">외 ${upcomingCount - renderedScheduleCount}건 · 제목을 눌러 일정 전체보기</div>`);
  }

  const myMemos = memos.filter(m => m.receivedBy === me || m.assignee === me);
  const activeMemos = myMemos.filter(m => m.status !== "확인됨");
  const mEl = document.getElementById("dash-memo-list");
  document.getElementById("dash-memo-count").textContent = activeMemos.length;
  mEl.innerHTML = "";
  if (!activeMemos.length) {
    mEl.innerHTML = `<div class="dash-empty">관련 메모가 없습니다</div>`;
  } else {
    const urgencyRank = { "상":0, "중":1, "하":2 };
    activeMemos.sort((a, b) => (urgencyRank[a.urgency] ?? 9) - (urgencyRank[b.urgency] ?? 9) || tsMillis(b.receivedAt) - tsMillis(a.receivedAt));
    activeMemos.slice(0, 5).forEach(m => {
      const div = document.createElement("div");
      div.className = "dash-card";
      div.innerHTML = `<div class="dc-title">${m.urgency === "상" ? '<span class="attention-badge">긴급</span> ' : ""}${escapeHtml(m.assignee || "미지정")} - ${escapeHtml(m.subject || "")} <span class="badge status-${m.status}">${m.status}</span></div>
        <div class="dc-meta">작성자 ${escapeHtml(m.receivedBy || "-")} · ${fmtTs(m.receivedAt)}</div>`;
      div.addEventListener("click", () => { openMemoEdit(m.id); });
      mEl.appendChild(div);
    });
    if (activeMemos.length > 5) mEl.insertAdjacentHTML("beforeend", `<div class="small-note" style="text-align:center;">외 ${activeMemos.length - 5}건 · 제목을 눌러 메모 전체보기</div>`);
  }

  /* 🔔 관련 변경사항 (최근 활동 피드) 생성 및 렌더링 */
  const activities = [];
  
  // 1. 업무 이력 추가
  myTickets.forEach(t => {
    if (t.history) {
      t.history.forEach(h => {
        activities.push({
          type: "ticket",
          id: t.id,
          title: t.title,
          author: h.author || t.requestedBy || "미지정",
          text: h.text,
          changePart: historyEntryType(h) === "note" ? "세부사항" : activityChangePart(h.text, "업무 정보"),
          timestamp: h.timestamp ? (h.timestamp.toDate ? h.timestamp.toDate() : new Date(h.timestamp)) : new Date(),
          icon: "✏️"
        });
      });
    }
    const detailAlreadyInHistory = (t.history || []).some(h => historyEntryType(h) === "note" && h.text === t.lastDetailText);
    if (t.lastDetailAt && t.lastDetailText && !detailAlreadyInHistory) {
      activities.push({
        type:"ticket", id:t.id, title:t.title, author:t.lastDetailAuthor || t.requestedBy || "미지정",
        text:t.lastDetailText, changePart:t.lastDetailKind === "detail" ? "세부사항" : activityChangePart(t.lastDetailText, "세부사항"),
        timestamp:t.lastDetailAt.toDate ? t.lastDetailAt.toDate() : new Date(t.lastDetailAt), icon:"✏️"
      });
    }
  });

  // 2. 일정/공사 이력 추가
  mySchedules.forEach(s => {
    if (s.history) {
      s.history.forEach(h => {
        activities.push({
          type: "schedule",
          scheduleType: s.type || "기타",
          id: s.id,
          title: s.title,
          author: h.author || s.registeredBy || "미지정",
          text: h.text,
          changePart: historyEntryType(h) === "note" ? "세부사항" : activityChangePart(h.text, "일정 정보"),
          timestamp: h.timestamp ? (h.timestamp.toDate ? h.timestamp.toDate() : new Date(h.timestamp)) : new Date(),
          icon: "🗓️"
        });
      });
    } else if (s.detail) {
      activities.push({
        type: "schedule",
        scheduleType: s.type || "기타",
        id: s.id,
        title: s.title,
        author: s.registeredBy || "미지정",
        text: s.detail,
        changePart: "세부사항",
        timestamp: s.registeredAt ? (s.registeredAt.toDate ? s.registeredAt.toDate() : new Date(s.registeredAt)) : new Date(),
        icon: "🗓️"
      });
    }
  });

  // 3. 메모 이력 추가
  myMemos.forEach(m => {
    if (m.receivedAt) {
      activities.push({
        type: "memo",
        id: m.id,
        title: `${m.assignee || "미지정"} - ${m.subject}`,
        author: m.receivedBy || "미지정",
        text: "메모 등록",
        changePart: "신규 등록",
        timestamp: m.receivedAt.toDate ? m.receivedAt.toDate() : new Date(m.receivedAt),
        icon: "📝"
      });
    }
    if (m.status === "확인됨" && m.confirmedAt) {
      activities.push({
        type: "memo",
        id: m.id,
        title: `${m.assignee || "미지정"} - ${m.subject}`,
        author: m.confirmedBy || "미지정",
        text: "메모 확인 완료",
        changePart: "확인상태",
        timestamp: m.confirmedAt.toDate ? m.confirmedAt.toDate() : new Date(m.confirmedAt),
        icon: "✅"
      });
    }
  });

  // 시간 역순(최신이 위로) 정렬
  activities.sort((a, b) => b.timestamp - a.timestamp);

  const actListEl = document.getElementById("dash-activity-list");
  actListEl.innerHTML = "";
  const visibleActivities = activities.slice(0, dashboardActivityExpanded ? 20 : 5);
  const activityToggle = document.getElementById("dash-activity-toggle");
  activityToggle.style.display = activities.length > 5 ? "inline-block" : "none";
  activityToggle.textContent = dashboardActivityExpanded ? "접기" : "전체보기";
  if (visibleActivities.length === 0) {
    actListEl.innerHTML = `<div class="dash-empty">관련 변경사항이 없습니다</div>`;
  } else {
    visibleActivities.forEach(act => {
      const div = document.createElement("div");
      div.className = "activity-feed-item";
      const timeStr = act.timestamp.toLocaleDateString("ko-KR", { month: "short", day: "numeric" }) + " " + act.timestamp.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
      div.innerHTML = `
        <div class="activity-feed-icon">${act.icon}</div>
        <div class="activity-feed-content">
          <div style="font-weight: 800; font-size: 14.5px;"><span class="activity-change-part">${escapeHtml(act.changePart || "내용")}</span>[${escapeHtml(act.type === "schedule" ? typeLabel(act.scheduleType) : LABEL_OF[act.type])}] ${escapeHtml(act.title)}</div>
          <div class="activity-feed-meta"><b>${escapeHtml(act.author)}</b> · ${escapeHtml(act.text)}</div>
        </div>
        <div class="activity-feed-time">${timeStr}</div>
      `;
      div.addEventListener("click", () => {
        if (act.type === "ticket") openTicketDetail(act.id, false);
        else if (act.type === "schedule") openScheduleEdit(act.id, false);
        else if (act.type === "memo") openMemoEdit(act.id);
      });
      actListEl.appendChild(div);
    });
  }
}

/* ════════════════════════════════════════════════
   모달 공통: ESC 키 / 우측상단 X 버튼으로 닫기
   ════════════════════════════════════════════════ */
document.getElementById("ticket-close-x").addEventListener("click", () => ticketOverlay.classList.remove("open"));
document.getElementById("schedule-close-x").addEventListener("click", () => scheduleOverlay.classList.remove("open"));
document.getElementById("memo-close-x").addEventListener("click", () => memoOverlay.classList.remove("open"));
const modalReturnFocus = new WeakMap();
[ticketOverlay, scheduleOverlay, memoOverlay].forEach(overlay => {
  if (!overlay) return;
  new MutationObserver(() => {
    if (overlay.classList.contains("open")) {
      if (!modalReturnFocus.has(overlay)) modalReturnFocus.set(overlay, document.activeElement);
      const target = overlay.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled])") || overlay.querySelector(".modal-box");
      if (target) target.focus();
    } else {
      const previous = modalReturnFocus.get(overlay);
      if (previous && document.contains(previous)) previous.focus();
      modalReturnFocus.delete(overlay);
    }
  }).observe(overlay, { attributes:true, attributeFilter:["class"] });
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) overlay.classList.remove("open"); });
});
document.addEventListener("keydown", (e) => {
  const openOverlay = [ticketOverlay, scheduleOverlay, memoOverlay].find(ov => ov.classList.contains("open"));
  if (e.key === "Escape") {
    [ticketOverlay, scheduleOverlay, memoOverlay].forEach(ov => ov.classList.remove("open"));
    return;
  }
  if (e.key !== "Tab" || !openOverlay) return;
  const focusable = [...openOverlay.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter(el => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
