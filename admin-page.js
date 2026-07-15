import { ensureUserLogin, logoutAccount, sendResetForLoginId } from "./account-auth.js";
import { installConnectionStatus, showToast, reportDataError, withBusyButton } from "./app-runtime.js";
import { SCHEMA_VERSION, monthKeysForDates } from "./data-model.js";
import {
  db, auth, collection, doc, addDoc, deleteDoc, updateDoc, setDoc, onSnapshot, query, orderBy, limit, startAfter, getDocs, where, writeBatch,
  TEAM_MEMBERS, USER_ACCOUNTS, serverTimestamp, Timestamp
} from "./firebase-config.js";

const adminProfile = await ensureUserLogin({ adminOnly: true });
installConnectionStatus();
const adminUidByName = new Map();
try {
  const profiles = await getDocs(collection(db, "users"));
  profiles.docs.forEach(item => { if (item.data().name) adminUidByName.set(item.data().name, item.id); });
} catch (error) { console.warn("사용자 UID 목록을 불러오지 못했습니다.", error); }

/* ───────── 로그아웃 ───────── */
document.getElementById("logout-btn").addEventListener("click", logoutAccount);

/* ───────── 공통 helper ───────── */
function pad(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmtTs(ts) {
  if (!ts) return "-";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return "-";
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function tsMillis(ts) {
  if (!ts) return 0;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const t = d.getTime();
  return isNaN(t) ? 0 : t;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function typeLabel(t) { return t === "공사" ? "공사(작업)" : t; }
function responsibleArray(rec) {
  if (Array.isArray(rec.responsible)) return rec.responsible;
  if (rec.responsible === "전체") return [...TEAM_MEMBERS];
  if (rec.responsible) return [rec.responsible];
  return [];
}
function ticketRecipients(rec) {
  const participants = Array.isArray(rec.participants) ? rec.participants.filter(name => name && name !== rec.requestedBy && name !== "관리자") : [];
  if (participants.length) return [...new Set(participants)];
  return rec.assignee && rec.assignee !== "관리자" ? [rec.assignee] : [];
}
function ticketMembers(rec) { return [...new Set([rec.requestedBy, ...ticketRecipients(rec)].filter(Boolean))]; }
function formatDateRanges(dates) {
  if (!dates || !dates.length) return "-";
  const sorted = [...new Set(dates)].sort();
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const prevDate = new Date(prev + "T00:00:00");
    prevDate.setDate(prevDate.getDate() + 1);
    if (d === isoDate(prevDate)) { prev = d; }
    else { ranges.push(start === prev ? start : `${start} ~ ${prev}`); start = d; prev = d; }
  }
  ranges.push(start === prev ? start : `${start} ~ ${prev}`);
  return ranges.join(", ");
}
function lastHistoryText(rec) {
  const h = rec.history;
  return (h && h.length) ? h[h.length - 1].text : "-";
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
switchTab("tickets");

const adminEditOverlay = document.getElementById("admin-edit-overlay");
const adminEditFields = document.getElementById("admin-edit-fields");
let adminEditing = null;
function adminField(label, control) { return `<div style="margin:12px 0;"><label style="display:block;font-weight:800;margin-bottom:6px;">${label}</label>${control}</div>`; }
function memberOptions(selected, includeBlank = false) {
  return (includeBlank ? `<option value="">미지정</option>` : "") + TEAM_MEMBERS.filter(n => n !== "관리자").map(n => `<option value="${escapeHtml(n)}" ${n === selected ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");
}
function inputControl(id, value, type = "text") { return `<input id="${id}" type="${type}" value="${escapeHtml(value || "")}" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;">`; }
function selectControl(id, options) { return `<select id="${id}" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;">${options}</select>`; }

function openAdminEditor(type, record) {
  adminEditorReturnFocus = document.activeElement;
  adminEditing = { type, record };
  document.getElementById("admin-edit-title").textContent = `${type === "tickets" ? "관련업무" : type === "schedules" ? "일정" : "메모"} 편집`;
  if (type === "tickets") {
    const statuses = ["미수신","열람","접수","진행중","보류","완료"];
    adminEditFields.innerHTML =
      adminField("제목", inputControl("ae-title", record.title)) +
      adminField("요청자", selectControl("ae-requested-by", memberOptions(record.requestedBy))) +
      adminField("구성원 (쉼표로 구분)", inputControl("ae-participants", ticketRecipients(record).join(", "))) +
      adminField("상태", selectControl("ae-status", statuses.map(s => `<option value="${s}" ${s === record.status ? "selected" : ""}>${s}</option>`).join(""))) +
      adminField("희망기한", inputControl("ae-due", record.dueDate, "date")) +
      adminField("관리자 세부사항", `<textarea id="ae-note" style="width:100%;min-height:90px;padding:10px;border:1px solid var(--line);border-radius:8px;" placeholder="필요한 경우 입력"></textarea>`);
  } else if (type === "schedules") {
    const types = ["공사","미팅","업무","기타"];
    adminEditFields.innerHTML =
      adminField("제목", inputControl("ae-title", record.title)) +
      adminField("유형", selectControl("ae-type", types.map(s => `<option value="${s}" ${s === record.type ? "selected" : ""}>${s}</option>`).join(""))) +
      adminField("날짜 (쉼표로 구분)", inputControl("ae-dates", (record.dates || []).join(", "))) +
      adminField("시간", inputControl("ae-time", record.time)) +
      adminField("업체/부서", inputControl("ae-vendor", record.vendor)) +
      adminField("담당자 (쉼표로 구분)", inputControl("ae-responsible", responsibleArray(record).join(", ")));
  } else {
    adminEditFields.innerHTML =
      adminField("용건", inputControl("ae-subject", record.subject)) +
      adminField("작성자", selectControl("ae-received-by", memberOptions(record.receivedBy))) +
      adminField("담당자", selectControl("ae-assignee", memberOptions(record.assignee, true))) +
      adminField("긴급도", selectControl("ae-urgency", ["상","중","하"].map(s => `<option value="${s}" ${s === record.urgency ? "selected" : ""}>${s}</option>`).join(""))) +
      adminField("상태", selectControl("ae-status", ["미확인","확인됨"].map(s => `<option value="${s}" ${s === record.status ? "selected" : ""}>${s}</option>`).join("")));
  }
  adminEditOverlay.style.display = "flex";
  adminEditOverlay.querySelector(".modal-card").focus();
}
let adminEditorReturnFocus = null;
function closeAdminEditor() {
  adminEditOverlay.style.display = "none";
  adminEditing = null;
  if (adminEditorReturnFocus && document.contains(adminEditorReturnFocus)) adminEditorReturnFocus.focus();
  adminEditorReturnFocus = null;
}
document.getElementById("admin-edit-cancel").onclick = closeAdminEditor;
document.getElementById("admin-edit-close").onclick = closeAdminEditor;

document.getElementById("admin-edit-save").onclick = async () => {
  if (!adminEditing) return;
  const button = document.getElementById("admin-edit-save");
  const { type, record } = adminEditing;
  button.disabled = true; button.textContent = "저장 중...";
  try {
    let payload;
    let ticketNote = "";
    let ticketNotifyTargets = [];
    if (type === "tickets") {
      const requestedBy = document.getElementById("ae-requested-by").value;
      const recipients = [...new Set(document.getElementById("ae-participants").value.split(",").map(name => name.trim()).filter(name => TEAM_MEMBERS.includes(name) && name !== requestedBy))];
      payload = { title:document.getElementById("ae-title").value.trim(), requestedBy, requestedByUid:adminUidByName.get(requestedBy) || null, assignee:recipients[0] || null, assigneeUid:adminUidByName.get(recipients[0]) || null, participants:[requestedBy, ...recipients], participantUids:[requestedBy, ...recipients].map(name => adminUidByName.get(name)).filter(Boolean), status:document.getElementById("ae-status").value, dueDate:document.getElementById("ae-due").value || null, updatedAt:serverTimestamp() };
      if (!payload.title || !recipients.length) { alert("제목과 구성원을 한 명 이상 입력하세요."); return; }
      ticketNote = document.getElementById("ae-note").value.trim();
      const targets = new Set([...ticketMembers(record), ...ticketMembers(payload)]);
      targets.delete("관리자"); targets.delete(null);
      ticketNotifyTargets = [...targets];
    } else if (type === "schedules") {
      const dates = document.getElementById("ae-dates").value.split(",").map(s => s.trim()).filter(Boolean);
      const responsible = document.getElementById("ae-responsible").value.split(",").map(s => s.trim()).filter(Boolean);
      payload = { title:document.getElementById("ae-title").value.trim(), type:document.getElementById("ae-type").value, dates, months:monthKeysForDates(dates), time:document.getElementById("ae-time").value.trim(), vendor:document.getElementById("ae-vendor").value.trim(), responsible, responsibleUids:responsible.map(name => adminUidByName.get(name)).filter(Boolean), schemaVersion:SCHEMA_VERSION, updatedAt:serverTimestamp() };
    } else {
      const receivedBy = document.getElementById("ae-received-by").value;
      const assignee = document.getElementById("ae-assignee").value || null;
      payload = { subject:document.getElementById("ae-subject").value.trim(), receivedBy, createdByName:receivedBy, createdByUid:adminUidByName.get(receivedBy) || record.createdByUid || null, assignee, assigneeUid:adminUidByName.get(assignee) || null, urgency:document.getElementById("ae-urgency").value, status:document.getElementById("ae-status").value, schemaVersion:SCHEMA_VERSION, updatedAt:serverTimestamp() };
      if (payload.status === "확인됨" && record.status !== "확인됨") { payload.confirmedBy = "관리자"; payload.confirmedAt = serverTimestamp(); }
    }
    const changedKeys = Object.keys(payload).filter(key => key !== "updatedAt");
    const beforeAudit = {}, afterAudit = {};
    changedKeys.forEach(key => { beforeAudit[key] = record[key] ?? null; afterAudit[key] = payload[key] ?? null; });
    await updateDoc(doc(db, CONFIGS[type].collectionName, record.id), payload);
    if (ticketNote) await addDoc(collection(db, "requestTickets", record.id, "details"), { text: ticketNote, kind: "detail", author: "관리자", authorUid: auth.currentUser?.uid || null, createdAt: serverTimestamp(), editedAt: null, archived: false });
    for (const name of ticketNotifyTargets) await addDoc(collection(db, "userNotifications", name, "items"), { ticketId: record.id, type: "admin_updated", message: "관리자가 관련업무 내용을 수정했습니다.", actor: "관리자", createdAt: serverTimestamp(), readAt: null });
    await addDoc(collection(db, "auditLogs"), { targetCollection: CONFIGS[type].collectionName, targetId: record.id, action: "admin_updated", actorName: "관리자", actorUid: auth.currentUser?.uid || null, before: beforeAudit, after: afterAudit, createdAt: serverTimestamp() });
    Object.assign(record, payload);
    renderTab(type);
    closeAdminEditor();
  } catch (error) { console.error(error); alert("수정 내용을 저장하지 못했습니다."); }
  finally { button.disabled = false; button.textContent = "저장"; }
};

/* ════════════════════════════════════════════════
   탭 설정: 관련업무 / 일정관리 / 메모
   각 탭은 동일한 구조(검색+상태/유형필터+기간필터+정렬가능한 헤더+엑셀다운로드)를 공유
   ════════════════════════════════════════════════ */
const CONFIGS = {
  tickets: {
    collectionName: "requestTickets",
    orderField: "requestedAt",
    dateOf: r => tsMillis(r.requestedAt),
    statusOf: r => r.status || "",
    searchText: r => [r.title, r.requestedBy, ...ticketRecipients(r)].filter(Boolean).join(" "),
    columns: [
      { key: "title", label: "제목", get: r => escapeHtml(r.title || "-"), sort: r => r.title || "" },
      { key: "requestedBy", label: "요청자", get: r => escapeHtml(r.requestedBy || "-"), sort: r => r.requestedBy || "" },
      { key: "participants", label: "구성원", get: r => escapeHtml(ticketRecipients(r).join(", ") || "-"), sort: r => ticketRecipients(r).join(", ") },
      { key: "requestedAt", label: "요청일", get: r => fmtTs(r.requestedAt), sort: r => tsMillis(r.requestedAt) },
      { key: "dueDate", label: "희망기한", get: r => r.dueDate || "-", sort: r => r.dueDate || "" },
      { key: "status", label: "상태", get: r => `<span class="badge ${r.status}">${escapeHtml(r.status || "-")}</span>`, sort: r => r.status || "" },
      { key: "updatedAt", label: "최종수정", get: r => fmtTs(r.updatedAt), sort: r => tsMillis(r.updatedAt) },
      { key: "lastNote", label: "최근내용", get: r => escapeHtml(lastHistoryText(r)), sort: null },
      { key: "deleteReq", label: "삭제요청", get: r => r.deleteRequestedBy ? escapeHtml(r.deleteRequestedBy) : "-", sort: null }
    ],
    excelRow: r => ({
      "제목": r.title || "", "요청자": r.requestedBy || "", "구성원": ticketRecipients(r).join(", "),
      "요청일": fmtTs(r.requestedAt), "희망기한": r.dueDate || "", "상태": r.status || "",
      "최종수정": fmtTs(r.updatedAt), "최근내용": lastHistoryText(r)
    })
  },
  schedules: {
    collectionName: "schedules",
    orderField: "registeredAt",
    dateOf: r => (Array.isArray(r.dates) && r.dates.length) ? new Date([...r.dates].sort()[0] + "T00:00:00").getTime() : 0,
    statusOf: r => r.type || "",
    searchText: r => [r.title, r.vendor, ...responsibleArray(r), r.registeredBy].filter(Boolean).join(" "),
    columns: [
      { key: "title", label: "제목", get: r => escapeHtml(r.title || "-"), sort: r => r.title || "" },
      { key: "type", label: "유형", get: r => `<span class="badge type-${r.type}">${escapeHtml(typeLabel(r.type))}</span>`, sort: r => r.type || "" },
      { key: "dates", label: "날짜", get: r => escapeHtml(formatDateRanges(r.dates)) + (r.time ? " " + escapeHtml(r.time) : ""), sort: r => (Array.isArray(r.dates) && r.dates.length) ? [...r.dates].sort()[0] : "" },
      { key: "vendor", label: "업체/부서", get: r => escapeHtml(r.vendor || "-"), sort: r => r.vendor || "" },
      { key: "responsible", label: "담당", get: r => escapeHtml(responsibleArray(r).join(", ") || "미지정"), sort: r => responsibleArray(r).join(", ") },
      { key: "registeredBy", label: "등록자", get: r => escapeHtml(r.registeredBy || "-"), sort: r => r.registeredBy || "" },
      { key: "registeredAt", label: "등록일시", get: r => fmtTs(r.registeredAt), sort: r => tsMillis(r.registeredAt) },
      { key: "deleteReq", label: "삭제요청", get: r => r.deleteRequestedBy ? escapeHtml(r.deleteRequestedBy) : "-", sort: null }
    ],
    excelRow: r => ({
      "제목": r.title || "", "유형": typeLabel(r.type || ""), "날짜": formatDateRanges(r.dates) + (r.time ? " " + r.time : ""),
      "업체/부서": r.vendor || "", "담당": responsibleArray(r).join(", "), "등록자": r.registeredBy || "",
      "등록일시": fmtTs(r.registeredAt)
    })
  },
  memos: {
    collectionName: "phoneMemos",
    orderField: "receivedAt",
    dateOf: r => tsMillis(r.receivedAt),
    statusOf: r => r.status || "",
    searchText: r => [r.subject, r.assignee, r.receivedBy].filter(Boolean).join(" "),
    columns: [
      { key: "assignee", label: "담당자", get: r => escapeHtml(r.assignee || "미지정"), sort: r => r.assignee || "" },
      { key: "subject", label: "용건", get: r => escapeHtml(r.subject || "-"), sort: r => r.subject || "" },
      { key: "urgency", label: "긴급도", get: r => `<span class="badge urgency-${r.urgency}">${escapeHtml(r.urgency || "-")}</span>`, sort: r => r.urgency || "" },
      { key: "receivedBy", label: "작성자", get: r => escapeHtml(r.receivedBy || "-"), sort: r => r.receivedBy || "" },
      { key: "receivedAt", label: "받은시간", get: r => fmtTs(r.receivedAt), sort: r => tsMillis(r.receivedAt) },
      { key: "status", label: "상태", get: r => `<span class="badge status-${r.status}">${escapeHtml(r.status || "-")}</span>`, sort: r => r.status || "" },
      { key: "confirmedBy", label: "확인자", get: r => escapeHtml(r.confirmedBy || "-"), sort: r => r.confirmedBy || "" },
      { key: "confirmedAt", label: "확인시간", get: r => fmtTs(r.confirmedAt), sort: r => tsMillis(r.confirmedAt) },
      { key: "deleteReq", label: "삭제요청", get: r => r.deleteRequestedBy ? escapeHtml(r.deleteRequestedBy) : "-", sort: null }
    ],
    excelRow: r => ({
      "담당자": r.assignee || "미지정", "용건": r.subject || "", "긴급도": r.urgency || "",
      "작성자": r.receivedBy || "", "받은시간": fmtTs(r.receivedAt), "상태": r.status || "",
      "확인자": r.confirmedBy || "", "확인시간": fmtTs(r.confirmedAt)
    })
  }
};

const state = {};
Object.keys(CONFIGS).forEach(k => {
  state[k] = {
    rows: [], search: "", statusFilter: "all", dateFrom: "", dateTo: "", sortKey: null, sortDir: 1,
    selected: new Set(), pageSize: 20, lastDoc: null, loadedAll: false, everLoaded: false
  };
});

function applyFilterSort(type) {
  const cfg = CONFIGS[type];
  const st = state[type];
  let rows = st.rows.slice();
  rows = rows.filter(r => !r.archived);

  if (st.search.trim()) {
    const q = st.search.trim().toLowerCase();
    rows = rows.filter(r => cfg.searchText(r).toLowerCase().includes(q));
  }
  if (st.statusFilter !== "all") {
    rows = rows.filter(r => cfg.statusOf(r) === st.statusFilter);
  }
  if (st.dateFrom) {
    const fromMs = new Date(st.dateFrom + "T00:00:00").getTime();
    rows = rows.filter(r => cfg.dateOf(r) >= fromMs);
  }
  if (st.dateTo) {
    const toMs = new Date(st.dateTo + "T23:59:59").getTime();
    rows = rows.filter(r => cfg.dateOf(r) <= toMs);
  }
  if (st.sortKey) {
    const col = cfg.columns.find(c => c.key === st.sortKey);
    if (col && col.sort) {
      rows.sort((a, b) => {
        const va = col.sort(a), vb = col.sort(b);
        if (va < vb) return -1 * st.sortDir;
        if (va > vb) return 1 * st.sortDir;
        return 0;
      });
    }
  }
  return rows;
}

function renderTab(type) {
  const cfg = CONFIGS[type];
  const st = state[type];
  const rows = applyFilterSort(type);

  const table = document.getElementById(type + "-table");
  const theadRow = table.querySelector("thead tr");
  theadRow.innerHTML = "";

  const thCheck = document.createElement("th");
  thCheck.className = "th-check";
  thCheck.innerHTML = `<input type="checkbox" class="select-all-cb" title="전체 선택" />`;
  theadRow.appendChild(thCheck);

  cfg.columns.forEach(col => {
    const th = document.createElement("th");
    let arrow = "";
    if (st.sortKey === col.key) arrow = `<span class="sort-arrow">${st.sortDir === 1 ? "▲" : "▼"}</span>`;
    th.innerHTML = `${col.label}${arrow}`;
    if (col.sort) {
      th.addEventListener("click", () => {
        if (st.sortKey === col.key) st.sortDir *= -1;
        else { st.sortKey = col.key; st.sortDir = 1; }
        renderTab(type);
      });
    }
    theadRow.appendChild(th);
  });
  const actionTh = document.createElement("th");
  actionTh.className = "th-action";
  actionTh.textContent = "편집";
  theadRow.appendChild(actionTh);

  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  if (!rows.length) {
    const msg = st.everLoaded ? "표시할 데이터가 없습니다" : "표시개수를 선택하고 조회 버튼을 눌러 데이터를 불러오세요";
    tbody.innerHTML = `<tr class="empty-row"><td class="empty-guide" colspan="${cfg.columns.length + 2}">${msg}</td></tr>`;
  } else {
    rows.forEach(r => {
      const tr = document.createElement("tr");
      const checked = st.selected.has(r.id) ? "checked" : "";
      const checkTd = `<td class="td-check"><input type="checkbox" class="row-cb" data-id="${r.id}" ${checked}/></td>`;
      tr.innerHTML = checkTd + cfg.columns.map(col => `<td>${col.get(r)}</td>`).join("") + `<td class="td-action"><button type="button" class="row-edit-btn" aria-label="${escapeHtml(r.title || r.subject || "자료")} 편집">편집</button></td>`;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", (event) => {
        if (event.target.closest("input,button,a,select")) return;
        openAdminEditor(type, r);
      });
      tr.querySelector(".row-edit-btn").addEventListener("click", () => openAdminEditor(type, r));
      tbody.appendChild(tr);
    });
  }

  const selectAllCb = theadRow.querySelector(".select-all-cb");
  selectAllCb.checked = rows.length > 0 && rows.every(r => st.selected.has(r.id));
  selectAllCb.addEventListener("change", () => {
    if (selectAllCb.checked) rows.forEach(r => st.selected.add(r.id));
    else rows.forEach(r => st.selected.delete(r.id));
    renderTab(type);
  });
  tbody.querySelectorAll(".row-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) st.selected.add(cb.dataset.id);
      else st.selected.delete(cb.dataset.id);
      renderTab(type);
    });
  });

  document.getElementById(type + "-count").textContent = `총 ${rows.length}건 (불러온 ${st.rows.length}건 중)`;
  const selNote = document.getElementById(type + "-selected-note");
  if (selNote) selNote.textContent = st.selected.size ? `선택 ${st.selected.size}건` : "";
}

function downloadExcel(rows, cfg, suffix) {
  if (!rows.length) { alert("다운로드할 데이터가 없습니다"); return; }
  const data = rows.map(cfg.excelRow);
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "데이터");
  const today = isoDate(new Date());
  XLSX.writeFile(wb, `${cfg.collectionName}${suffix ? "_" + suffix : ""}_${today}.xlsx`);
}

/* DB 읽기 비용 절감을 위해 실시간 onSnapshot 대신, 표시개수를 선택하고 "조회"를 눌러야 그만큼만 불러옴.
   "더 불러오기"를 누르면 이어서 다음 페이지를 추가로 가져옴 (Firestore 커서 기반 페이지네이션). */
async function loadPage(type, reset) {
  const cfg = CONFIGS[type];
  const st = state[type];
  if (reset) { st.rows = []; st.lastDoc = null; st.loadedAll = false; st.selected.clear(); }
  if (st.loadedAll) return;

  const loadBtn = document.getElementById(type + "-load");
  const moreBtn = document.getElementById(type + "-load-more");
  loadBtn.disabled = true; moreBtn.disabled = true;
  try {
    let q = st.lastDoc
      ? query(collection(db, cfg.collectionName), orderBy(cfg.orderField, "desc"), startAfter(st.lastDoc), limit(st.pageSize))
      : query(collection(db, cfg.collectionName), orderBy(cfg.orderField, "desc"), limit(st.pageSize));
    const snap = await getDocs(q);
    if (snap.docs.length < st.pageSize) st.loadedAll = true;
    if (snap.docs.length) {
      st.lastDoc = snap.docs[snap.docs.length - 1];
      const newRows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      st.rows = st.rows.concat(newRows);
    }
    st.everLoaded = true;
    renderTab(type);
    moreBtn.style.display = st.loadedAll ? "none" : "inline-block";
  } catch (e) {
    console.error(`${cfg.collectionName} 조회 오류`, e);
    alert("데이터를 불러오는 중 오류가 발생했습니다");
  } finally {
    loadBtn.disabled = false; moreBtn.disabled = false;
  }
}

async function bulkDeleteSelected(type) {
  const st = state[type];
  if (!st.selected.size) { alert("선택된 항목이 없습니다"); return; }
  const ids = [...st.selected];
  const label = type === "tickets" ? "관련업무" : type === "schedules" ? "일정" : "메모";
  if (!confirm(`선택한 ${label} ${ids.length}건을 자료보관으로 이동할까요? 자료보관에서 복원할 수 있습니다.`)) return;
  for (const id of ids) {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, CONFIGS[type].collectionName, id), { archived:true, archivedAt:serverTimestamp(), archivedBy:"관리자", archivedByUid:adminProfile.uid, updatedAt:serverTimestamp() });
      batch.set(doc(collection(db, "auditLogs")), { targetCollection:CONFIGS[type].collectionName, targetId:id, action:`${type}_archived`, actorName:"관리자", actorUid:adminProfile.uid, createdAt:serverTimestamp() });
      await batch.commit();
    } catch (e) { console.error("자료보관 이동 오류", e); }
  }
  st.rows = st.rows.filter(r => !st.selected.has(r.id));
  st.selected.clear();
  renderTab(type);
}

function wireFilters(type) {
  document.getElementById(type + "-search").addEventListener("input", (e) => {
    state[type].search = e.target.value;
    renderTab(type);
  });
  const statusSel = document.getElementById(type + (type === "schedules" ? "-type-filter" : "-status-filter"));
  statusSel.addEventListener("change", (e) => {
    state[type].statusFilter = e.target.value;
    renderTab(type);
  });
  document.getElementById(type + "-date-from").addEventListener("change", (e) => {
    state[type].dateFrom = e.target.value;
    renderTab(type);
  });
  document.getElementById(type + "-date-to").addEventListener("change", (e) => {
    state[type].dateTo = e.target.value;
    renderTab(type);
  });
  document.getElementById(type + "-filter-reset").addEventListener("click", () => {
    state[type].search = ""; state[type].statusFilter = "all"; state[type].dateFrom = ""; state[type].dateTo = "";
    document.getElementById(type + "-search").value = "";
    statusSel.value = "all";
    document.getElementById(type + "-date-from").value = "";
    document.getElementById(type + "-date-to").value = "";
    renderTab(type);
  });
  document.getElementById(type + "-export").addEventListener("click", () => {
    downloadExcel(applyFilterSort(type), CONFIGS[type], "");
  });
  document.getElementById(type + "-export-selected").addEventListener("click", () => {
    const st = state[type];
    if (!st.selected.size) { alert("선택된 항목이 없습니다"); return; }
    downloadExcel(st.rows.filter(r => st.selected.has(r.id)), CONFIGS[type], "선택");
  });
  document.getElementById(type + "-bulk-delete").addEventListener("click", () => bulkDeleteSelected(type));

  const pageSizeSel = document.getElementById(type + "-page-size");
  pageSizeSel.addEventListener("change", (e) => { state[type].pageSize = +e.target.value; });
  document.getElementById(type + "-load").addEventListener("click", () => loadPage(type, true));
  document.getElementById(type + "-load-more").addEventListener("click", () => loadPage(type, false));
}
Object.keys(CONFIGS).forEach(wireFilters);

/* ════════════════════════════════════════════════
   변경사항 이력 (활동 피드): 각 컬렉션 최근 N건을 불러와 history를 펼쳐서 시간순으로 합산 표시
   ════════════════════════════════════════════════ */
const activityState = { pageSize: 20, rows: [] };
const AUDIT_ACTION_LABELS = {
  ticket_created: "관련업무 생성", ticket_opened: "업무 열람", status_changed: "상태 변경",
  ticket_reopened: "완료 업무 재개", detail_added: "세부사항 추가", detail_edited: "세부사항 수정",
  detail_archived: "세부사항 삭제", ticket_updated: "관련업무 수정", admin_updated: "관리자 수정",
  ticket_archived: "자료보관 이동", legacy_assignee_assigned: "기존 업무 수신자 지정",
  delete_requested: "삭제 요청", delete_request_approved: "삭제 요청 승인"
};
const AUDIT_COLLECTION_LABELS = { requestTickets: "관련업무", schedules: "일정관리", phoneMemos: "메모" };
function memoEvents(r) {
  const events = [];
  if (r.receivedAt) events.push({ coll: "메모", title: r.subject || "-", text: "메모 등록", author: r.receivedBy || "-", timestamp: r.receivedAt });
  if (r.status === "확인됨" && r.confirmedAt) {
    events.push({ coll: "메모", title: r.subject || "-", text: `확인 처리`, author: r.confirmedBy || "-", timestamp: r.confirmedAt });
  }
  return events;
}
async function loadActivity() {
  const btn = document.getElementById("activity-load");
  btn.disabled = true;
  try {
    const n = activityState.pageSize;
    const auditSnap = await getDocs(query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(n)));
    const items = auditSnap.docs.map(d => {
      const r = d.data();
      return {
        coll: AUDIT_COLLECTION_LABELS[r.targetCollection] || r.targetCollection || "-",
        title: (r.after && r.after.title) || (r.before && r.before.title) || r.targetId || "-",
        text: AUDIT_ACTION_LABELS[r.action] || r.action || "-",
        author: r.actorName || "-", timestamp: r.createdAt
      };
    });
    activityState.rows = items;
    renderActivity();
  } catch (e) {
    console.error("변경사항 이력 조회 오류", e);
    alert("변경사항 이력을 불러오는 중 오류가 발생했습니다");
  } finally {
    btn.disabled = false;
  }
}
function renderActivity() {
  const table = document.getElementById("activity-table");
  const tbody = table.querySelector("tbody");
  tbody.innerHTML = "";
  const rows = activityState.rows;
  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td class="empty-guide" colspan="5">표시할 이력이 없습니다</td></tr>`;
  } else {
    rows.forEach(ev => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${fmtTs(ev.timestamp)}</td><td>${escapeHtml(ev.coll)}</td><td>${escapeHtml(ev.title)}</td><td>${escapeHtml(ev.author)}</td><td>${escapeHtml(ev.text)}</td>`;
      tbody.appendChild(tr);
    });
  }
  document.getElementById("activity-count").textContent = `총 ${rows.length}건`;
}
document.getElementById("activity-page-size").addEventListener("change", (e) => { activityState.pageSize = +e.target.value; });
document.getElementById("activity-load").addEventListener("click", loadActivity);
document.getElementById("activity-export").addEventListener("click", () => {
  if (!activityState.rows.length) { alert("다운로드할 데이터가 없습니다"); return; }
  const data = activityState.rows.map(ev => ({ "시각": fmtTs(ev.timestamp), "구분": ev.coll, "제목/용건": ev.title, "작성자": ev.author, "내용": ev.text }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "변경이력");
  XLSX.writeFile(wb, `변경사항이력_${isoDate(new Date())}.xlsx`);
});

/* ════════════════════════════════════════════════
   공휴일 관리: 기본 KR_HOLIDAYS(firebase-config.js 내장)에 없는 임시공휴일 등을
   여기서 등록하면 customHolidays 컬렉션에 저장되고, 월간일정 화면에 바로 반영됨.
   등록 건수가 적으므로 실시간 구독(onSnapshot) 사용.
   ════════════════════════════════════════════════ */
let holidaysRows = [];
function renderHolidays() {
  const tbody = document.querySelector("#holidays-table tbody");
  tbody.innerHTML = "";
  if (!holidaysRows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="3" class="empty-guide">등록된 임시 공휴일이 없습니다</td></tr>`;
  } else {
    holidaysRows.forEach(h => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(h.id)}</td><td>${escapeHtml(h.name || "-")}</td><td><button class="row-delete-btn" type="button">✕ 삭제</button></td>`;
      tr.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`${h.id} (${h.name || "-"}) 항목을 삭제할까요?`)) return;
        try { await deleteDoc(doc(db, "customHolidays", h.id)); } catch (e) { console.error("공휴일 삭제 오류", e); }
      });
      tbody.appendChild(tr);
    });
  }
  document.getElementById("holidays-count").textContent = `총 ${holidaysRows.length}건`;
}
onSnapshot(collection(db, "customHolidays"), (snap) => {
  holidaysRows = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.id < b.id ? -1 : 1);
  renderHolidays();
}, (err) => console.error("customHolidays 구독 오류", err));

document.getElementById("holiday-add-btn").addEventListener("click", async () => {
  const dateVal = document.getElementById("holiday-date-input").value;
  const nameVal = document.getElementById("holiday-name-input").value.trim();
  if (!dateVal) { alert("날짜를 선택하세요"); return; }
  if (!nameVal) { alert("공휴일 이름을 입력하세요"); return; }
  try {
    await setDoc(doc(db, "customHolidays", dateVal), { name: nameVal });
    document.getElementById("holiday-date-input").value = "";
    document.getElementById("holiday-name-input").value = "";
  } catch (e) {
    console.error("공휴일 등록 오류", e);
    alert("등록 중 오류가 발생했습니다");
  }
});

async function loadArchive() {
  const tbody = document.getElementById("archive-tbody");
  tbody.innerHTML = `<tr><td colspan="6">불러오는 중...</td></tr>`;
  const configs = [
    { type:"관련업무", key:"ticket", collectionName:"requestTickets", author:r => r.requestedBy },
    { type:"일정", key:"schedule", collectionName:"schedules", author:r => r.registeredBy },
    { type:"메모", key:"memo", collectionName:"phoneMemos", author:r => r.createdByName || r.receivedBy }
  ];
  const snaps = await Promise.all(configs.map(cfg => getDocs(query(collection(db, cfg.collectionName), where("archived", "==", true), limit(100)))));
  const rows = snaps.flatMap((snap, index) => snap.docs.map(d => ({ id:d.id, ...d.data(), _cfg:configs[index] })))
    .sort((a, b) => tsMillis(b.archivedAt) - tsMillis(a.archivedAt));
  tbody.innerHTML = "";
  rows.forEach(row => {
    const tr = document.createElement("tr");
    const cfg = row._cfg;
    tr.innerHTML = `<td>${cfg.type}</td><td>${escapeHtml(row.title || row.subject || "-")}</td><td>${escapeHtml(cfg.author(row) || "-")}</td><td>${escapeHtml(row.archivedBy || "-")}</td><td>${fmtTs(row.archivedAt)}</td><td><button class="restore-btn btn-secondary">복원</button> <button class="purge-btn row-delete-btn">영구삭제</button></td>`;
    tr.querySelector(".restore-btn").onclick = async () => { await updateDoc(doc(db, cfg.collectionName, row.id), { archived:false, restoredAt:serverTimestamp(), restoredBy:"관리자", restoredByUid:adminProfile.uid, updatedAt:serverTimestamp() }); await loadArchive(); };
    tr.querySelector(".purge-btn").onclick = async () => {
      if (!confirm("세부사항을 포함해 영구 삭제합니다. 복구할 수 없습니다. 계속할까요?")) return;
      const details = cfg.key === "memo" ? null : await getDocs(collection(db, cfg.collectionName, row.id, "details"));
      const batch = writeBatch(db);
      if (details) details.docs.slice(0, 450).forEach(d => batch.delete(d.ref));
      batch.delete(doc(db, cfg.collectionName, row.id));
      await batch.commit();
      await loadArchive();
    };
    tbody.appendChild(tr);
  });
  if (!rows.length) tbody.innerHTML = `<tr><td colspan="6">보관된 자료가 없습니다.</td></tr>`;
  document.getElementById("archive-count").textContent = `총 ${rows.length}건`;
}
document.getElementById("archive-load").addEventListener("click", loadArchive);

function encodeBackupValue(value) {
  if (value && typeof value.toDate === "function") return { __timestamp: value.toDate().toISOString() };
  if (Array.isArray(value)) return value.map(encodeBackupValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeBackupValue(v)]));
  return value;
}
function decodeBackupValue(value) {
  if (value && typeof value === "object" && typeof value.__timestamp === "string") return Timestamp.fromDate(new Date(value.__timestamp));
  if (Array.isArray(value)) return value.map(decodeBackupValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeBackupValue(v)]));
  return value;
}
async function collectBackupDocs() {
  const docs = [];
  const userUids = [];
  const topCollections = ["users", "requestTickets", "schedules", "phoneMemos", "customHolidays", "auditLogs", "system"];
  for (const name of topCollections) {
    const snap = await getDocs(collection(db, name));
    snap.docs.forEach(item => docs.push({ path:item.ref.path, data:encodeBackupValue(item.data()) }));
    if (name === "users") snap.docs.forEach(item => userUids.push(item.id));
    if (["requestTickets", "schedules"].includes(name)) {
      for (const item of snap.docs) {
        const details = await getDocs(collection(db, name, item.id, "details"));
        details.docs.forEach(detail => docs.push({ path:detail.ref.path, data:encodeBackupValue(detail.data()) }));
      }
    }
  }
  const notificationOwners = [...new Set([...TEAM_MEMBERS, ...Object.keys(USER_ACCOUNTS), ...userUids])];
  for (const owner of notificationOwners) {
    const snap = await getDocs(collection(db, "userNotifications", owner, "items"));
    snap.docs.forEach(item => docs.push({ path:item.ref.path, data:encodeBackupValue(item.data()) }));
  }
  return docs;
}
document.getElementById("backup-download").addEventListener("click", async e => withBusyButton(e.currentTarget, "백업 중...", async () => {
  const status = document.getElementById("data-management-status");
  try {
    const docs = await collectBackupDocs();
    const payload = { format:"smc-fm-backup", version:1, schemaVersion:SCHEMA_VERSION, projectId:"smc-fm", exportedAt:new Date().toISOString(), documentCount:docs.length, docs };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `smc-fm-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    status.textContent = `${docs.length}개 문서를 백업했습니다.`;
  } catch (error) { reportDataError("백업", error); }
}));

async function restoreBackupDocuments(entries) {
  const userEntries = entries.filter(entry => entry.path.startsWith("users/"));
  const ordered = entries.filter(entry => !entry.path.startsWith("users/"));
  if (userEntries.length) {
    const userBatch = writeBatch(db);
    userEntries.forEach(entry => userBatch.set(doc(db, ...entry.path.split("/")), decodeBackupValue(entry.data), { merge:true }));
    await userBatch.commit();
  }
  for (let offset = 0; offset < ordered.length; offset += 400) {
    const batch = writeBatch(db);
    ordered.slice(offset, offset + 400).forEach(entry => {
      if (!entry.path || !entry.data) throw new Error("잘못된 백업 문서");
      batch.set(doc(db, ...entry.path.split("/")), decodeBackupValue(entry.data), { merge:true });
    });
    await batch.commit();
  }
}
document.getElementById("restore-run").addEventListener("click", async e => withBusyButton(e.currentTarget, "복구 중...", async () => {
  const file = document.getElementById("restore-file").files[0];
  if (!file) { alert("복구할 JSON 백업 파일을 선택하세요."); return; }
  if (!confirm("백업 내용을 현재 데이터에 병합합니다. 같은 문서 ID는 백업 내용으로 갱신됩니다. 계속할까요?")) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.format !== "smc-fm-backup" || !Array.isArray(payload.docs)) throw new Error("지원하지 않는 백업 형식");
    await restoreBackupDocuments(payload.docs);
    document.getElementById("data-management-status").textContent = `${payload.docs.length}개 문서를 복구했습니다.`;
    showToast("백업 복구가 완료되었습니다");
  } catch (error) { reportDataError("백업 복구", error); }
}));

document.getElementById("notifications-cleanup").addEventListener("click", async e => withBusyButton(e.currentTarget, "정리 중...", async () => {
  if (!confirm("90일이 지난 읽은 알림을 영구 삭제할까요?")) return;
  const cutoff = Timestamp.fromDate(new Date(Date.now() - 90 * 86400000));
  const users = await getDocs(collection(db, "users"));
  const owners = [...new Set([...TEAM_MEMBERS, ...Object.keys(USER_ACCOUNTS), ...users.docs.map(item => item.id)])];
  let deleted = 0;
  for (const owner of owners) {
    const snap = await getDocs(query(collection(db, "userNotifications", owner, "items"), where("readAt", "<", cutoff), limit(300)));
    if (!snap.empty) {
      const batch = writeBatch(db); snap.docs.forEach(item => batch.delete(item.ref)); await batch.commit(); deleted += snap.size;
    }
  }
  document.getElementById("data-management-status").textContent = `${deleted}개의 오래된 알림을 정리했습니다.`;
}));

document.getElementById("schema-migrate").addEventListener("click", async e => withBusyButton(e.currentTarget, "보완 중...", async () => {
  const users = await getDocs(collection(db, "users"));
  const uidByName = new Map(users.docs.map(item => [item.data().name, item.id]));
  const targets = [
    { name:"requestTickets", patch:r => ({ schemaVersion:SCHEMA_VERSION, requestedByUid:r.requestedByUid || uidByName.get(r.requestedBy) || null, participantUids:[...new Set((r.participants || []).map(n => uidByName.get(n)).filter(Boolean))] }) },
    { name:"schedules", patch:r => ({ schemaVersion:SCHEMA_VERSION, registeredByUid:r.registeredByUid || uidByName.get(r.registeredBy) || null, responsibleUids:[...new Set(responsibleArray(r).map(n => uidByName.get(n)).filter(Boolean))], months:monthKeysForDates(r.dates || []) }) },
    { name:"phoneMemos", patch:r => ({ schemaVersion:SCHEMA_VERSION, createdByName:r.createdByName || r.receivedBy || null, createdByUid:r.createdByUid || uidByName.get(r.createdByName || r.receivedBy) || null, assigneeUid:r.assigneeUid || uidByName.get(r.assignee) || null }) }
  ];
  let updated = 0;
  for (const target of targets) {
    const snap = await getDocs(collection(db, target.name));
    for (let offset = 0; offset < snap.docs.length; offset += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(offset, offset + 400).forEach(item => batch.update(item.ref, target.patch(item.data())));
      await batch.commit(); updated += Math.min(400, snap.docs.length - offset);
    }
  }
  const schedules = await getDocs(collection(db, "schedules"));
  for (const item of schedules.docs) {
    const row = item.data();
    if (row.detailsMigrated) continue;
    const legacy = (row.history && row.history.length) ? row.history : (row.detail ? [{ text:row.detail, author:row.registeredBy, timestamp:row.registeredAt }] : []);
    const batch = writeBatch(db);
    legacy.slice(0, 450).forEach((detail, index) => {
      const detailId = detail.id || `legacy-${String(index).padStart(4, "0")}`;
      batch.set(doc(db, "schedules", item.id, "details", detailId), {
        text:detail.text || "", author:detail.author || row.registeredBy || "-", authorUid:adminUidByName.get(detail.author) || null,
        createdAt:detail.timestamp || row.registeredAt || serverTimestamp(), editedAt:detail.editedAt || null,
        archived:false, migrated:true, schemaVersion:SCHEMA_VERSION
      }, { merge:true });
    });
    const last = legacy.length ? legacy[legacy.length - 1] : null;
    batch.update(item.ref, {
      detailsMigrated:true, legacyHistoryArchived:true, history:[], detail:null, schemaVersion:SCHEMA_VERSION,
      ...(last ? { lastDetailText:last.text || "", lastDetailAuthor:last.author || row.registeredBy || "-", lastDetailAuthorUid:adminUidByName.get(last.author) || null, lastDetailAt:last.timestamp || row.updatedAt || row.registeredAt || serverTimestamp() } : {})
    });
    await batch.commit();
  }
  await setDoc(doc(db, "system", "app"), { scheduleMonthIndexReady:true, schemaVersion:SCHEMA_VERSION, migratedAt:serverTimestamp(), migratedByUid:adminProfile.uid }, { merge:true });
  document.getElementById("data-management-status").textContent = `${updated}개 기존 문서의 UID·월 검색 필드를 보완했습니다.`;
}));

function renderUserAdmin() {
  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = "";
  Object.entries(USER_ACCOUNTS).forEach(([id, account]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(id)}</td><td>${escapeHtml(account.email)}</td><td>${escapeHtml(account.role)}</td><td><button class="btn-secondary reset-mail-btn">재설정 메일 발송</button></td>`;
    tr.querySelector("button").onclick = async () => {
      try { await sendResetForLoginId(id); alert(`${account.email}로 비밀번호 재설정 메일을 보냈습니다.`); }
      catch (e) { alert("메일을 보내지 못했습니다."); }
    };
    tbody.appendChild(tr);
  });
}
renderUserAdmin();

document.getElementById("unassigned-load").addEventListener("click", async () => {
  const tbody = document.getElementById("unassigned-tbody");
  tbody.innerHTML = `<tr><td colspan="3">불러오는 중...</td></tr>`;
  const snap = await getDocs(query(collection(db, "requestTickets"), orderBy("requestedAt", "desc"), limit(100)));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.assignee && !t.archived);
  tbody.innerHTML = "";
  rows.forEach(ticket => {
    const tr = document.createElement("tr");
    const options = TEAM_MEMBERS.filter(n => n !== "관리자" && n !== ticket.requestedBy).map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    tr.innerHTML = `<td>${escapeHtml(ticket.title || "-")}</td><td>${escapeHtml(ticket.requestedBy || "-")}</td><td><select>${options}</select> <button class="btn-primary">지정</button></td>`;
    tr.querySelector("button").onclick = async () => {
      const assignee = tr.querySelector("select").value;
      await updateDoc(doc(db, "requestTickets", ticket.id), { assignee, participants:[ticket.requestedBy, assignee], status:"미수신", receivedAt:null, receivedBy:null, updatedAt:serverTimestamp() });
      await setDoc(doc(collection(db, "auditLogs")), { targetCollection: "requestTickets", targetId: ticket.id, action: "legacy_assignee_assigned", actorName: "관리자", before: { assignee: null }, after: { assignee }, createdAt: serverTimestamp() });
      tr.remove();
    };
    tbody.appendChild(tr);
  });
  if (!rows.length) tbody.innerHTML = `<tr><td colspan="3">수신자 미지정 업무가 없습니다.</td></tr>`;
});

/* 키보드 조작: 탭 이동, 편집창 닫기와 포커스 순환 */
document.getElementById("tabbar").addEventListener("keydown", e => {
  if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
  const tabs = [...document.querySelectorAll(".tab-btn")];
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  e.preventDefault();
  const next = e.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
});
adminEditOverlay.addEventListener("mousedown", e => { if (e.target === adminEditOverlay) closeAdminEditor(); });
document.addEventListener("keydown", e => {
  if (adminEditOverlay.style.display !== "flex") return;
  if (e.key === "Escape") { closeAdminEditor(); return; }
  if (e.key !== "Tab") return;
  const focusable = [...adminEditOverlay.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")].filter(el => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
