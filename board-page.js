import { ensureAccess } from "./auth-gate.js";
import { installConnectionStatus, reportDataError } from "./app-runtime.js";
import {
  db, collection, doc, updateDoc, onSnapshot, query, orderBy, limit, where, getDoc, getDocs, serverTimestamp, Timestamp, TEAM_MEMBERS, KR_HOLIDAYS
} from "./firebase-config.js";

await ensureAccess();
installConnectionStatus();

/* ───────── 시계 ───────── */
function tickClock() {
  const now = new Date();
  const days = ["일","월","화","수","목","금","토"];
  document.getElementById("clock").textContent =
    `${now.getFullYear()}.${String(now.getMonth()+1).padStart(2,"0")}.${String(now.getDate()).padStart(2,"0")} (${days[now.getDay()]}) ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
  document.getElementById("aux-date").textContent =
    `${now.getFullYear()}년 ${now.getMonth()+1}월 ${now.getDate()}일 (${days[now.getDay()]})`;
  document.getElementById("aux-time").textContent =
    `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
}
tickClock();
setInterval(tickClock, 1000); // 초 단위로 갱신 — 화면이 살아있는지(멈추지 않았는지) 확인용

/* ───────── 매일 17:26 짧은 3음 알림 ───────── */
let boardAudioContext = null;
let boardSoundMuted = localStorage.getItem("smcfm_board_muted") === "1";
async function ensureBoardAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return false;
  if (!boardAudioContext) boardAudioContext = new AudioContextClass();
  if (boardAudioContext.state === "suspended") {
    try { await boardAudioContext.resume(); } catch (_) { return false; }
  }
  return boardAudioContext.state === "running";
}
async function playBoardChime() {
  if (boardSoundMuted) return false;
  if (!(await ensureBoardAudio())) return false;
  const start = boardAudioContext.currentTime;
  [659.25, 783.99, 987.77].forEach((frequency, index) => {
    const oscillator = boardAudioContext.createOscillator();
    const gain = boardAudioContext.createGain();
    const at = start + index * 0.22;
    oscillator.frequency.value = frequency;
    oscillator.type = "sine";
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.22, at + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
    oscillator.connect(gain); gain.connect(boardAudioContext.destination);
    oscillator.start(at); oscillator.stop(at + 0.2);
  });
  return true;
}
document.getElementById("chime-test-btn").addEventListener("click", async () => {
  const played = await playBoardChime();
  if (!played) alert(boardSoundMuted ? "현재 음소거 상태입니다. 음소거를 해제한 뒤 다시 눌러주세요." : "브라우저에서 소리를 재생하지 못했습니다. 전자칠판의 음량과 브라우저 소리 권한을 확인해 주세요.");
});
function updateMuteButton() {
  const button = document.getElementById("sound-mute-btn");
  button.classList.toggle("is-muted", boardSoundMuted);
  button.setAttribute("aria-pressed", String(boardSoundMuted));
  button.title = boardSoundMuted ? "전자칠판 소리 켜기" : "전자칠판 소리 끄기";
  button.setAttribute("aria-label", button.title);
}
document.getElementById("sound-mute-btn").addEventListener("click", () => {
  boardSoundMuted = !boardSoundMuted;
  localStorage.setItem("smcfm_board_muted", boardSoundMuted ? "1" : "0");
  if (boardSoundMuted && "speechSynthesis" in window) window.speechSynthesis.cancel();
  updateMuteButton();
});
function speakHourlyTime(now) {
  if (boardSoundMuted || !("speechSynthesis" in window)) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(`${now.getHours()}시입니다.`);
  utterance.lang = "ko-KR";
  utterance.rate = 0.92;
  utterance.pitch = 1;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
  return true;
}
updateMuteButton();
// 페이지 이용 중 최초 클릭/키 입력 때 오디오를 준비해 17:26 자동재생 차단 가능성을 줄인다.
document.addEventListener("pointerdown", ensureBoardAudio, { once:true });
document.addEventListener("keydown", ensureBoardAudio, { once:true });
ensureBoardAudio();

/* ───────── 전체화면 토글 ───────── */
const fullscreenBtn = document.getElementById("fullscreen-btn");
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}
function requestFullscreen(el) {
  const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
  if (fn) fn.call(el);
}
function exitFullscreen() {
  const fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  if (fn) fn.call(document);
}
function updateFullscreenBtn() {
  const on = isFullscreen();
  fullscreenBtn.classList.toggle("is-active", on);
  fullscreenBtn.title = on ? "전체화면 종료" : "전체화면";
}
fullscreenBtn.addEventListener("click", () => {
  if (isFullscreen()) exitFullscreen();
  else requestFullscreen(document.documentElement);
});
["fullscreenchange", "webkitfullscreenchange", "MSFullscreenChange"].forEach(ev =>
  document.addEventListener(ev, updateFullscreenBtn)
);
updateFullscreenBtn();

/* ───────── 상태 ───────── */
let viewYear, viewMonth; // viewMonth: 0-indexed
{
  const t = new Date();
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
}
let schedules = [];
let memos = [];
let tickets = [];
/* 관리자 화면(admin.html)에서 등록한 임시 공휴일 등 (기본 KR_HOLIDAYS에 없는 날짜를 추가로 반영) */
let customHolidays = {};
function holidayName(iso) { return customHolidays[iso] || KR_HOLIDAYS[iso]; }

/* ───────── Firestore 구독 ───────── */
let scheduleUnsubscribe = null;
let scheduleMonthIndexReady = false;
function monthKey(year, month) {
  const d = new Date(year, month, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
async function subscribeScheduleRange() {
  if (scheduleUnsubscribe) scheduleUnsubscribe();
  try {
    const config = await getDoc(doc(db, "system", "app"));
    scheduleMonthIndexReady = config.exists() && config.data().scheduleMonthIndexReady === true;
  } catch (_) { scheduleMonthIndexReady = false; }
  const now = new Date();
  const months = [...new Set([
    monthKey(viewYear, viewMonth - 1), monthKey(viewYear, viewMonth), monthKey(viewYear, viewMonth + 1),
    monthKey(now.getFullYear(), now.getMonth())
  ])];
  const scheduleQuery = scheduleMonthIndexReady
    ? query(collection(db, "schedules"), where("months", "array-contains-any", months), limit(500))
    : query(collection(db, "schedules"), orderBy("registeredAt", "desc"), limit(300));
  scheduleUnsubscribe = onSnapshot(scheduleQuery, snap => {
    schedules = snap.docs.map(d => ({ id:d.id, ...d.data() })).filter(s => !s.archived);
    renderCalendar(); renderAuxWeek(); renderAuxToday();
  }, error => reportDataError("일정 불러오기", error));
}
subscribeScheduleRange();

onSnapshot(query(collection(db, "requestTickets"), orderBy("updatedAt", "desc"), limit(100)), (snap) => {
  tickets = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => !t.archived && t.status !== "완료");
  renderAlerts();
  renderAuxDue();
}, error => reportDataError("관련업무 불러오기", error));

onSnapshot(query(collection(db, "phoneMemos"), orderBy("receivedAt", "desc"), limit(100)), (snap) => {
  memos = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => !m.archived);
  renderAlerts();
}, error => reportDataError("메모 불러오기", error));

onSnapshot(collection(db, "customHolidays"), (snap) => {
  const map = {};
  snap.docs.forEach(d => { map[d.id] = (d.data() && d.data().name) || "공휴일"; });
  customHolidays = map;
  renderCalendar();
});

/* ───────── 캘린더 렌더링 ───────── */
function pad(n) { return String(n).padStart(2, "0"); }
function isoDate(y, m, d) { return `${y}-${pad(m+1)}-${pad(d)}`; }
/* 일정 담당(복수지정) 필드를 항상 배열로 정규화 (구 데이터: 문자열 이름/"전체"/빈 값 도 지원) */
function responsibleArray(rec) {
  if (Array.isArray(rec.responsible)) return rec.responsible;
  if (rec.responsible === "전체") return [...TEAM_MEMBERS];
  if (rec.responsible) return [rec.responsible];
  return [];
}
function responsibleLabel(rec) {
  const list = responsibleArray(rec);
  if (!list.length) return "미지정";
  if (TEAM_MEMBERS.length > 0 && TEAM_MEMBERS.every(name => list.includes(name))) return "전체";
  return list.join(", ");
}
function ticketRecipients(rec) {
  const participants = Array.isArray(rec.participants)
    ? rec.participants.filter(name => name && name !== rec.requestedBy && name !== "관리자")
    : [];
  if (participants.length) return [...new Set(participants)];
  return rec.assignee && rec.assignee !== "관리자" ? [rec.assignee] : [];
}
function ticketRecipientLabel(rec) { return ticketRecipients(rec).join(", ") || "미지정"; }
/* "2026-07-15" → "07/15" */
function mdShort(iso) { return iso.slice(5,7) + "/" + iso.slice(8,10); }
/* 연속된 날짜들을 "07/15~07/23" 형태의 범위 목록으로 압축 (입력화면과 동일한 방식) */
function formatDateRanges(dates) {
  if (!dates || !dates.length) return "-";
  const sorted = [...new Set(dates)].sort();
  const ranges = [];
  let start = sorted[0], prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i];
    const prevDate = new Date(prev + "T00:00:00");
    prevDate.setDate(prevDate.getDate() + 1);
    const nextIso = isoDate(prevDate.getFullYear(), prevDate.getMonth(), prevDate.getDate());
    if (d === nextIso) {
      prev = d;
    } else {
      ranges.push(start === prev ? mdShort(start) : `${mdShort(start)}~${mdShort(prev)}`);
      start = d; prev = d;
    }
  }
  ranges.push(start === prev ? mdShort(start) : `${mdShort(start)}~${mdShort(prev)}`);
  return ranges.join(", ");
}
/* 다음 날짜 iso 계산 (주 경계 넘어 이어지는 일정인지 판단용) */
function addDaysIso(iso, delta) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return isoDate(d.getFullYear(), d.getMonth(), d.getDate());
}

/* ── 일정별 고유 색조 자동 부여 ─────────────────────
   같은 유형(공사/미팅/업무) 안에서도 일정마다 살짝 다른 색조를 고정 배정하여,
   여러 일정이 몰려 있어도 서로 구분이 쉽도록 한다. (문서 id 기반 해시 → 항상 동일한 색) */
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
const TYPE_VAR = { "공사": "--type-공사", "미팅": "--type-미팅", "업무": "--type-업무", "기타": "--type-기타" };
const scheduleColorCache = {};
function scheduleColorVariant(type, id) {
  const cacheKey = (type || "업무") + "|" + id;
  if (scheduleColorCache[cacheKey]) return scheduleColorCache[cacheKey];
  const baseHex = getComputedStyle(document.documentElement).getPropertyValue(TYPE_VAR[type] || TYPE_VAR["업무"]).trim();
  const [h, s, l] = hexToHsl(baseHex);
  const hash = hashStr(String(id || ""));
  const hueShift = (hash % 25) - 12;       // -12 ~ +12도
  const lightShift = ((hash >> 5) % 14) - 7; // -7 ~ +7
  const hue = (h + hueShift + 360) % 360;
  const fgL = Math.max(20, Math.min(45, l + lightShift));
  const bgL = Math.max(88, Math.min(96, 92 + lightShift / 2));
  const variant = {
    fg: `hsl(${hue.toFixed(0)}, ${s.toFixed(0)}%, ${fgL.toFixed(0)}%)`,
    bg: `hsl(${hue.toFixed(0)}, ${Math.max(20, s - 10).toFixed(0)}%, ${bgL.toFixed(0)}%)`
  };
  scheduleColorCache[cacheKey] = variant;
  return variant;
}

function renderCalendar() {
  document.getElementById("month-title").textContent = `${viewYear}년 ${viewMonth+1}월`;

  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth+1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

  const cells = [];
  // 이전달 채우기
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: daysInPrevMonth - i, other: true, y: viewMonth === 0 ? viewYear-1 : viewYear, m: (viewMonth+11)%12 });
  }
  // 이번달
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ day: d, other: false, y: viewYear, m: viewMonth });
  }
  // 다음달 채우기 (7의 배수로)
  while (cells.length % 7 !== 0) {
    const idx = cells.length - (firstDow + daysInMonth);
    cells.push({ day: idx + 1, other: true, y: viewMonth === 11 ? viewYear+1 : viewYear, m: (viewMonth+1)%12 });
  }

  const todayIso = isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const grid = document.getElementById("cal-grid");
  grid.innerHTML = "";

  // 한 주(7칸)씩 처리 — 같은 주 안에서 연속된 날짜에 걸친 일정은 끊기지 않는 하나의 막대로 표시
  for (let w = 0; w < cells.length / 7; w++) {
    const weekCells = cells.slice(w * 7, w * 7 + 7);
    const weekIsos = weekCells.map(c => isoDate(c.y, c.m, c.day));

    const weekEl = document.createElement("div");
    weekEl.className = "cal-week";

    // 날짜 숫자 행
    const daynumsEl = document.createElement("div");
    daynumsEl.className = "cal-daynums";
    weekCells.forEach((c, i) => {
      const iso = weekIsos[i];
      const dowIdx = new Date(c.y, c.m, c.day).getDay();
      const hName = holidayName(iso);
      const isRedDay = dowIdx === 0 || dowIdx === 6 || !!hName;

      const cell = document.createElement("div");
      cell.className = "day-cell" + (c.other ? " other-month" : "");
      cell.tabIndex = 0;
      cell.setAttribute("role", "button");
      cell.setAttribute("aria-label", `${c.y}년 ${c.m + 1}월 ${c.day}일 일정 보기`);

      const numWrap = document.createElement("div");
      numWrap.className = "day-num" + (isRedDay ? " is-redday" : "");
      let numHtml = iso === todayIso ? `<span class="today-badge">${c.day}</span>` : `<span>${c.day}</span>`;
      if (hName) numHtml += `<span class="holiday-name" title="${escapeHtml(hName)}">${escapeHtml(hName)}</span>`;
      numWrap.innerHTML = numHtml;
      cell.appendChild(numWrap);
      cell.addEventListener("click", () => openDayDetail(iso, c.y, c.m, c.day));
      cell.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); openDayDetail(iso, c.y, c.m, c.day); } });
      daynumsEl.appendChild(cell);
    });
    weekEl.appendChild(daynumsEl);

    // 이 주에 걸친 각 일정의 연속 구간(세그먼트) 계산
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

    // 겹치지 않도록 레인(줄) 배정
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
        const laneRow = document.createElement("div");
        laneRow.className = "cal-lane";
        lanesEl.appendChild(laneRow);
        return laneRow;
      });
      segments.forEach(seg => {
        const bar = document.createElement("div");
        bar.className = "event-chip type-" + (seg.s.type || "업무");
        bar.style.gridColumn = `${seg.startCol + 1} / ${seg.endCol + 2}`;
        // 장기 연속일정(같은 주 안에서 이틀 이상 이어지는 구간)은 업체 옆에 "07/15~07/23" 범위를 표시
        const allDates = [...new Set(Array.isArray(seg.s.dates) ? seg.s.dates : [])].sort();
        const fullRange = allDates.length
          ? (allDates[0] === allDates[allDates.length - 1] ? mdShort(allDates[0]) : `${mdShort(allDates[0])}~${mdShort(allDates[allDates.length - 1])}`)
          : "";
        const vendorText = seg.s.vendor ? ` (${seg.s.vendor})` : "";
        const timeText = seg.s.time ? `${seg.s.time} ` : "";
        // 주 경계를 넘어 이어지는 일정은 각진 모서리 + 화살표로 이어짐을 표시 (다른 일정과 혼동 방지)
        const contPrev = seg.startCol === 0 && Array.isArray(seg.s.dates) && seg.s.dates.includes(addDaysIso(weekIsos[0], -1));
        const contNext = seg.endCol === 6 && Array.isArray(seg.s.dates) && seg.s.dates.includes(addDaysIso(weekIsos[6], 1));
        bar.classList.toggle("cont-prev", contPrev);
        bar.classList.toggle("cont-next", contNext);
        if (allDates.length === 1) {
          bar.classList.add("single-day");
          const main = document.createElement("div");
          main.className = "event-main";
          main.textContent = timeText + seg.s.title;
          bar.appendChild(main);
          if (seg.s.vendor) {
            const vendors = String(seg.s.vendor).split(/[,;\/\n·]+/).map(v => v.trim()).filter(Boolean);
            const sub = document.createElement("div");
            sub.className = "event-sub";
            sub.textContent = vendors.length > 1 ? `${vendors[0]} 외 ${vendors.length - 1}곳` : vendors[0];
            bar.appendChild(sub);
          }
        } else {
          bar.textContent = (contPrev ? "◀ " : "") + timeText + seg.s.title + vendorText + (fullRange ? ` ${fullRange}` : "") + (contNext ? " ▶" : "");
        }
        // 일정별 고유 색조 부여 (같은 유형 안에서도 항목마다 구분되도록)
        const variant = scheduleColorVariant(seg.s.type, seg.s.id);
        bar.style.backgroundColor = variant.bg;
        bar.style.color = variant.fg;
        bar.style.borderLeftColor = variant.fg;
        bar.addEventListener("click", (e) => {
          e.stopPropagation();
          const c = weekCells[seg.startCol];
          openDayDetail(weekIsos[seg.startCol], c.y, c.m, c.day);
        });
        laneRows[seg.lane].appendChild(bar);
      });
      weekEl.appendChild(lanesEl);
    }

    grid.appendChild(weekEl);
  }

  fitCalendarDensity();
}

/* 전자칠판 월간화면 맞춤:
   1) 일정량에 따라 적은 주의 높이를 줄이고 많은 주에 공간을 더 배정
   2) 그래도 부족하면 읽을 수 있는 범위(density-2)까지만 글자를 축소
   3) 마지막으로 넘치는 레인만 숨기고 +N건을 표시
   이렇게 해서 스크롤 없이 5~6주 전체 날짜가 항상 보이도록 한다. */
function naturalWeekHeight(week) {
  const dates = week.querySelector(".cal-daynums");
  const lanes = week.querySelector(".cal-lanes");
  return Math.ceil((dates?.scrollHeight || 0) + (lanes?.scrollHeight || 0) + 1);
}
function resetWeekOverflow(weeks) {
  weeks.forEach(week => {
    week.style.flex = "0 0 auto";
    week.style.height = "auto";
    week.classList.remove("week-compact");
    week.querySelectorAll(".cal-lane").forEach(lane => { lane.hidden = false; });
    week.querySelector(".week-more")?.remove();
  });
}
function distributeWeekHeights(natural, minimum, available) {
  const heights = minimum.slice();
  let remaining = Math.max(0, available - heights.reduce((sum, h) => sum + h, 0));
  for (let pass = 0; pass < 4 && remaining > 0.5; pass++) {
    const needs = natural.map((h, i) => Math.max(0, h - heights[i]));
    const totalNeed = needs.reduce((sum, n) => sum + n, 0);
    if (totalNeed <= 0) break;
    needs.forEach((need, i) => {
      const add = Math.min(need, remaining * (need / totalNeed));
      heights[i] += add;
    });
    remaining = Math.max(0, available - heights.reduce((sum, h) => sum + h, 0));
  }
  if (remaining > 0) {
    // Once every week has its natural height, share spare screen space evenly.
    // Weighting this by content made an already busy week retain a large blank area.
    const extraPerWeek = remaining / Math.max(1, heights.length);
    heights.forEach((_, i) => { heights[i] += extraPerWeek; });
  }
  return heights;
}
function applyWeekHeights(weeks, heights, minimum, available) {
  let used = 0;
  weeks.forEach((week, index) => {
    const height = index === weeks.length - 1
      ? Math.max(minimum[index], available - used)
      : Math.max(minimum[index], Math.floor(heights[index]));
    week.style.flex = `0 0 ${height}px`;
    week.style.height = `${height}px`;
    used += height;
  });
}
function collapseOverflowingWeek(week) {
  const lanesEl = week.querySelector(".cal-lanes");
  if (!lanesEl || week.scrollHeight <= week.clientHeight + 1) return;

  // Keep every schedule visible when compact single-line rows are enough.
  // Only fall back to +N after this busy-week-only layout has also overflowed.
  week.classList.add("week-compact");
  void week.offsetHeight;
  if (week.scrollHeight <= week.clientHeight + 1) return;

  const laneRows = [...lanesEl.querySelectorAll(".cal-lane")];
  let hiddenCount = 0;
  const marker = document.createElement("div");
  marker.className = "week-more";
  lanesEl.appendChild(marker);
  for (let i = laneRows.length - 1; i >= 0 && week.scrollHeight > week.clientHeight + 1; i--) {
    hiddenCount += laneRows[i].querySelectorAll(".event-chip").length;
    laneRows[i].hidden = true;
    marker.textContent = `+ 일정 ${hiddenCount}건 · 날짜를 눌러 전체 확인`;
  }
  if (!hiddenCount) marker.remove();
}
function fitCalendarDensity() {
  const wrap = document.getElementById("cal-wrap");
  const grid = document.getElementById("cal-grid");
  const weeks = [...grid.querySelectorAll(".cal-week")];
  const available = grid.clientHeight;
  if (!weeks.length || available <= 0) return;

  // Try the smallest global tier before hiding rows. Busy weeks can still use
  // their own compact single-line layout in collapseOverflowingWeek().
  const tiers = ["density-plus-4", "density-plus-3", "density-plus-2", "density-plus-1", "", "density-1", "density-2", "density-3"];
  let natural = [];
  let minimum = [];
  for (const tier of tiers) {
    wrap.className = tier;
    resetWeekOverflow(weeks);
    void grid.offsetHeight;
    natural = weeks.map(naturalWeekHeight);
    minimum = weeks.map(week => Math.ceil((week.querySelector(".cal-daynums")?.scrollHeight || 0) + 24));
    if (natural.reduce((sum, h) => sum + h, 0) <= available) break;
  }

  let heights = distributeWeekHeights(natural, minimum, available);
  applyWeekHeights(weeks, heights, minimum, available);

  // Compaction changes the natural height of a busy week. Re-measure after that
  // change so a height calculated from the pre-compaction rows is not left blank.
  for (let pass = 0; pass < 2; pass++) {
    let compacted = false;
    weeks.forEach(week => {
      if (!week.classList.contains("week-compact") && week.querySelector(".cal-lanes") && week.scrollHeight > week.clientHeight + 1) {
        week.classList.add("week-compact");
        compacted = true;
      }
    });
    if (!compacted) break;

    weeks.forEach(week => {
      week.style.flex = "0 0 auto";
      week.style.height = "auto";
    });
    void grid.offsetHeight;
    natural = weeks.map(naturalWeekHeight);
    minimum = weeks.map(week => Math.ceil((week.querySelector(".cal-daynums")?.scrollHeight || 0) + 24));
    heights = distributeWeekHeights(natural, minimum, available);
    applyWeekHeights(weeks, heights, minimum, available);
  }

  weeks.forEach(collapseOverflowingWeek);
}
let densityResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(densityResizeTimer);
  densityResizeTimer = setTimeout(fitCalendarDensity, 150);
});
window.addEventListener("load", fitCalendarDensity);
if (document.fonts?.ready) document.fonts.ready.then(fitCalendarDensity);

/* ───────── 날짜 확대보기 (노안 배려) ───────── */
const dayDetailOverlay = document.getElementById("day-detail-overlay");
function openDayDetail(iso, y, m, d) {
  const days = ["일","월","화","수","목","금","토"];
  const dow = days[new Date(y, m, d).getDay()];
  document.getElementById("day-detail-date").innerHTML =
    `${y}년 ${m+1}월 ${d}일 <span class="dow">(${dow}요일)</span>`;

  const evEl = document.getElementById("day-detail-events");
  evEl.innerHTML = "";
  const dayEvents = schedules.filter(s => Array.isArray(s.dates) && s.dates.includes(iso));
  if (dayEvents.length === 0) {
    evEl.innerHTML = `<div id="day-detail-empty">등록된 일정이 없습니다</div>`;
  } else {
    dayEvents.forEach(ev => {
      const div = document.createElement("div");
      div.className = "day-detail-event type-" + (ev.type || "업무");
      div.tabIndex = 0;
      div.setAttribute("role", "button");
      const variant = scheduleColorVariant(ev.type, ev.id);
      div.style.backgroundColor = variant.bg;
      div.style.color = variant.fg;
      div.style.borderLeftColor = variant.fg;
      const lastDetail = ev.lastDetailText || (Array.isArray(ev.history) && ev.history.length ? ev.history[ev.history.length-1].text : ev.detail);
      div.innerHTML = `${ev.time ? `<b>${escapeHtml(ev.time)}</b> ` : ""}${escapeHtml(ev.title)}${ev.vendor ? ` (${escapeHtml(ev.vendor)})` : ""}
        <div class="dd-meta">담당: ${escapeHtml(responsibleLabel(ev))}${lastDetail ? " · " + escapeHtml(lastDetail) : ""}</div>`;
      div.addEventListener("click", (e) => {
        e.stopPropagation();
        openEventDetail(ev);
      });
      div.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); openEventDetail(ev); } });
      evEl.appendChild(div);
    });
  }
  dayDetailOverlay.classList.add("open");
}
document.getElementById("day-detail-close").addEventListener("click", () => dayDetailOverlay.classList.remove("open"));
dayDetailOverlay.addEventListener("click", (e) => {
  if (e.target === dayDetailOverlay) dayDetailOverlay.classList.remove("open");
});

/* ───────── 개별 일정 상세내역 ───────── */
const eventDetailOverlay = document.getElementById("event-detail-overlay");
async function openEventDetail(ev) {
  document.getElementById("event-detail-title").textContent = ev.title || "-";

  const metaLines = [];
  metaLines.push(`유형: <b>${escapeHtml(ev.type === "공사" ? "공사(작업)" : (ev.type || "-"))}</b>`);
  if (ev.vendor) metaLines.push(`업체/부서: <b>${escapeHtml(ev.vendor)}</b>`);
  metaLines.push(`담당: <b>${escapeHtml(responsibleLabel(ev))}</b>`);
  metaLines.push(`날짜: <b>${escapeHtml(formatDateRanges(ev.dates))}</b>${ev.time ? ` <b>${escapeHtml(ev.time)}</b>` : ""}`);
  metaLines.push(`등록자: <b>${escapeHtml(ev.registeredBy || "-")}</b>`);
  document.getElementById("event-detail-meta").innerHTML = metaLines.join("<br>");

  const histEl = document.getElementById("event-detail-history");
  histEl.innerHTML = "";
  let hist = (ev.history && ev.history.length) ? ev.history
    : (ev.detail ? [{ text: ev.detail, author: ev.registeredBy, timestamp: ev.registeredAt }] : []);
  try {
    const detailSnap = await getDocs(query(collection(db, "schedules", ev.id, "details"), orderBy("createdAt", "asc"), limit(100)));
    const detailRows = detailSnap.docs.map(item => ({ id:item.id, ...item.data() })).filter(item => !item.archived);
    if (detailRows.length) hist = detailRows;
  } catch (error) { console.warn("일정 세부사항을 불러오지 못해 기존 이력을 표시합니다.", error); }
  if (!hist.length) {
    histEl.innerHTML = `<div class="event-detail-empty-hist">등록된 상세내용이 없습니다</div>`;
  } else {
    hist.slice().reverse().forEach(h => {
      const div = document.createElement("div");
      div.className = "eh-item";
      div.innerHTML = `<div class="eh-meta">${escapeHtml(h.author || "-")} · ${fmtTimestamp(h.createdAt || h.timestamp)}</div><div>${escapeHtml(h.text)}</div>`;
      histEl.appendChild(div);
    });
  }
  eventDetailOverlay.classList.add("open");
}
document.getElementById("event-detail-close").addEventListener("click", () => eventDetailOverlay.classList.remove("open"));
eventDetailOverlay.addEventListener("click", (e) => {
  if (e.target === eventDetailOverlay) eventDetailOverlay.classList.remove("open");
});

/* ───────── 관련업무(티켓) 상세내역 (일정 상세보기와 동일한 팝업을 재사용) ───────── */
function openTicketDetailBoard(t) {
  document.getElementById("event-detail-title").textContent = t.title || "-";

  const metaLines = [];
  metaLines.push(`상태: <b>${escapeHtml(t.status || "-")}</b>`);
  metaLines.push(`요청자: <b>${escapeHtml(t.requestedBy || "-")}</b>`);
  metaLines.push(`구성원: <b>${escapeHtml(ticketRecipientLabel(t))}</b>`);
  metaLines.push(`요청일: <b>${fmtTimestamp(t.requestedAt)}</b>`);
  if (t.dueDate) metaLines.push(`희망기한: <b>${escapeHtml(t.dueDate)}</b>`);
  document.getElementById("event-detail-meta").innerHTML = metaLines.join("<br>");

  const histEl = document.getElementById("event-detail-history");
  histEl.innerHTML = "";
  const hist = t.history || [];
  if (!hist.length) {
    histEl.innerHTML = `<div class="event-detail-empty-hist">등록된 상세내용이 없습니다</div>`;
  } else {
    hist.slice().reverse().forEach(h => {
      const div = document.createElement("div");
      div.className = "eh-item";
      div.innerHTML = `<div class="eh-meta">${escapeHtml(h.author || "-")} · ${fmtTimestamp(h.timestamp)}</div><div>${escapeHtml(h.text)}</div>`;
      histEl.appendChild(div);
    });
  }
  eventDetailOverlay.classList.add("open");
}

document.getElementById("prev-month").addEventListener("click", () => {
  viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  subscribeScheduleRange();
});
document.getElementById("next-month").addEventListener("click", () => {
  viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  subscribeScheduleRange();
});
document.getElementById("month-title").addEventListener("click", () => {
  const t = new Date();
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
  subscribeScheduleRange();
});

/* ───────── 알림 패널 렌더링 ───────── */
function fmtTimestamp(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tsMillis(ts) {
  if (!ts) return 0;
  return ts.toDate ? ts.toDate().getTime() : new Date(ts).getTime();
}

/* 연속으로 같은 담당자+용건인 항목은 한 줄로 묶어서 보여줌 (세로 폭 절약) */
function groupConsecutive(list) {
  const groups = [];
  list.forEach(m => {
    const last = groups[groups.length - 1];
    const key = (m.assignee || "") + "|" + (m.subject || "");
    if (last && last.key === key) {
      last.items.push(m);
    } else {
      groups.push({ key, assignee: m.assignee, subject: m.subject, items: [m] });
    }
  });
  return groups;
}
const URGENCY_ORDER = { "상": 3, "중": 2, "하": 1 };
function topUrgency(items) {
  return items.reduce((top, m) => (URGENCY_ORDER[m.urgency] || 2) > (URGENCY_ORDER[top] || 0) ? m.urgency : top, items[0].urgency || "중");
}

/* 관련업무(티켓)의 최근 활동 시각 (정렬 기준) */
function ticketMillis(t) {
  if (t.updatedAt) return tsMillis(t.updatedAt);
  if (t.requestedAt) return tsMillis(t.requestedAt);
  return 0;
}

function buildMemoAlertCard(g, now) {
  const card = document.createElement("div");
  const receivedMs = g.items[0].receivedAt?.toDate ? g.items[0].receivedAt.toDate().getTime() : now;
  const isOld = (now - receivedMs) > 24 * 60 * 60 * 1000;
  card.className = "alert-card " + (isOld ? "urgent-blink" : "pulsing");
  const countText = g.items.length > 1 ? ` · ${g.items.length}건` : "";
  card.innerHTML = `
    <div class="alert-line">
      <span class="title">${escapeHtml(g.subject || "")}(메모${countText})</span>
      <span class="alert-sep">/</span>
      <span class="assignee-name">${escapeHtml(g.assignee || "미지정")}</span>
    </div>
  `;
  card.addEventListener("click", () => openMemoDetail(g, false));
  return card;
}
function buildTicketAlertCard(t, now) {
  const card = document.createElement("div");
  const baseMs = ticketMillis(t) || now;
  const isOld = (now - baseMs) > 24 * 60 * 60 * 1000;
  card.className = "alert-card " + (isOld ? "urgent-blink" : "pulsing");
  card.innerHTML = `
    <div class="alert-line">
      <span class="title">${escapeHtml(t.title || "-")}(업무)</span>
      <span class="alert-sep">/</span>
      <span class="assignee-name">${escapeHtml(t.requestedBy || "-")}</span>
    </div>
  `;
  card.addEventListener("click", () => openTicketDetailBoard(t));
  return card;
}
/* 업무진행상황: 신규 상태값(미확인/확인됨/진행중/보류/완료) 기준으로 3그룹 분류.
   담당자 필드가 없어졌으므로, "확인만 하고 상태가 안 바뀐 것"은 status==="확인됨"으로 직접 판단 */
function updatedMillis(rec) {
  if (rec.updatedAt) return tsMillis(rec.updatedAt);
  const last = rec.history && rec.history.length ? rec.history[rec.history.length - 1] : null;
  return last ? tsMillis(last.timestamp) : 0;
}
function buildProgressCard(t, variant) {
  const card = document.createElement("div");
  card.className = "progress-card" + (variant ? " " + variant : "");
  card.innerHTML = `
    <div class="title-row"><span class="type-tag type-tag-ticket">업무</span><span class="title">${escapeHtml(t.title || "-")}</span></div>
    <div>${escapeHtml(t.status || "-")} · 요청 ${escapeHtml(t.requestedBy || "-")} · 구성원 ${escapeHtml(ticketRecipientLabel(t))} · ${fmtTimestamp(t.updatedAt)}</div>
  `;
  card.addEventListener("click", () => openTicketDetailBoard(t));
  return card;
}

let progressPage = 0;
const PROGRESS_PAGE_SIZE = 8;
function renderProgressList() {
  const activeTickets = tickets.filter(t => t.status !== "완료" && !["미수신", "미확인", "요청됨"].includes(t.status));
  const stalled = activeTickets.filter(t => ["열람", "접수", "확인됨"].includes(t.status))
    .sort((a, b) => updatedMillis(b) - updatedMillis(a));
  const inProgress = activeTickets.filter(t => t.status === "진행중")
    .sort((a, b) => updatedMillis(b) - updatedMillis(a));
  const onHold = activeTickets.filter(t => t.status === "보류")
    .sort((a, b) => updatedMillis(b) - updatedMillis(a));
  const ordered = [
    ...stalled.map(t => ({ t, variant: "stalled" })),
    ...inProgress.map(t => ({ t, variant: "" })),
    ...onHold.map(t => ({ t, variant: "hold" }))
  ];

  const totalPages = Math.max(1, Math.ceil(ordered.length / PROGRESS_PAGE_SIZE));
  progressPage = Math.min(progressPage, totalPages - 1);
  const pageItems = ordered.slice(progressPage * PROGRESS_PAGE_SIZE, (progressPage + 1) * PROGRESS_PAGE_SIZE);

  const doneEl = document.getElementById("done-list");
  doneEl.innerHTML = "";
  if (!ordered.length) {
    doneEl.innerHTML = `<div class="empty-alert">표시할 업무가 없습니다</div>`;
  } else {
    pageItems.forEach(({ t, variant }) => doneEl.appendChild(buildProgressCard(t, variant)));
  }
  document.getElementById("progress-page-info").textContent = `${progressPage + 1} / ${totalPages}`;
  document.getElementById("progress-prev").disabled = progressPage === 0;
  document.getElementById("progress-next").disabled = progressPage >= totalPages - 1;
}
document.getElementById("progress-prev").addEventListener("click", () => { progressPage--; renderProgressList(); });
document.getElementById("progress-next").addEventListener("click", () => { progressPage++; renderProgressList(); });

function renderAlerts() {
  const now = Date.now();

  const unconfirmedMemoGroups = groupConsecutive(memos.filter(m => m.status !== "확인됨"))
    .map(g => ({ kind: "memo", group: g, ms: tsMillis(g.items[0].receivedAt) }));
  const unconfirmedTicketItems = tickets.filter(t => ["미수신", "미확인", "요청됨"].includes(t.status))
    .map(t => ({ kind: "ticket", rec: t, ms: ticketMillis(t) }));

  const unconfirmedAll = [...unconfirmedMemoGroups, ...unconfirmedTicketItems].sort((a, b) => b.ms - a.ms);

  const listEl = document.getElementById("alert-list");
  const auxListEl = document.getElementById("aux-alert-list");
  listEl.innerHTML = "";
  auxListEl.innerHTML = "";
  if (unconfirmedAll.length === 0) {
    listEl.innerHTML = `<div class="empty-alert">미확인 항목이 없습니다</div>`;
    auxListEl.innerHTML = `<div class="empty-alert">미확인 항목이 없습니다</div>`;
  } else {
    unconfirmedAll.forEach(entry => {
      listEl.appendChild(entry.kind === "memo" ? buildMemoAlertCard(entry.group, now) : buildTicketAlertCard(entry.rec, now));
      auxListEl.appendChild(entry.kind === "memo" ? buildMemoAlertCard(entry.group, now) : buildTicketAlertCard(entry.rec, now));
    });
  }

  renderProgressList();
  scheduleAuxFit();
}

/* ───────── 전자칠판 보조화면: 이번주 일정 / 오늘 일정 (날짜/내용 순서로 나열) ───────── */
function buildAgendaRow(dateLabel, ev) {
  const row = document.createElement("div");
  row.className = "agenda-row";
  row.innerHTML = `
    ${dateLabel ? `<span class="agenda-date">${escapeHtml(dateLabel)}</span>` : ""}
    <span class="agenda-title">${escapeHtml(ev.title || "-")}</span>
    <span class="agenda-assignee">${escapeHtml(responsibleLabel(ev))}</span>
  `;
  row.addEventListener("click", () => openEventDetail(ev));
  return row;
}
const AUX_DOW = ["일","월","화","수","목","금","토"];
/* 오늘을 포함하는 주(일~토)의 날짜(iso) 목록 */
function weekRangeIsos(base) {
  const dow = base.getDay();
  const sunday = new Date(base);
  sunday.setDate(base.getDate() - dow);
  const isos = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    isos.push(isoDate(d.getFullYear(), d.getMonth(), d.getDate()));
  }
  return isos;
}
function renderAuxWeek() {
  const weekIsos = weekRangeIsos(new Date());
  const groups = [];
  weekIsos.forEach(iso => {
    const d = new Date(iso + "T00:00:00");
    const label = `${d.getMonth()+1}/${d.getDate()}(${AUX_DOW[d.getDay()]})`;
    const items = schedules.filter(s => Array.isArray(s.dates) && s.dates.includes(iso));
    items.sort((a, b) => {
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });
    if (items.length) groups.push({ iso, label, items });
  });
  const el = document.getElementById("aux-week-list");
  el.innerHTML = "";
  if (!groups.length) {
    el.innerHTML = `<div class="empty-alert">이번주 일정이 없습니다</div>`;
  } else {
    const today = isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    const makeDayGroup = ({ iso, label, items }) => {
      const group = document.createElement("section");
      group.className = "agenda-day-group";
      const head = document.createElement("div");
      head.className = "agenda-day-head" + (iso === today ? " is-today" : "");
      head.textContent = iso === today ? `${label} · 오늘` : label;
      group.appendChild(head);
      items.forEach(s => group.appendChild(buildAgendaRow(s.time || "종일", s)));
      return group;
    };

    if (groups.length === 1) {
      el.appendChild(makeDayGroup(groups[0]));
    } else {
      const half = groups.length / 2;
      const splitCandidates = [...new Set([Math.floor(half), Math.ceil(half)])].filter(index => index > 0 && index < groups.length);
      const groupLoad = group => group.items.length + 0.7;
      const splitIndex = splitCandidates.reduce((best, candidate) => {
        const leftLoad = groups.slice(0, candidate).reduce((sum, group) => sum + groupLoad(group), 0);
        const rightLoad = groups.slice(candidate).reduce((sum, group) => sum + groupLoad(group), 0);
        const score = Math.abs(leftLoad - rightLoad);
        return score < best.score ? { index:candidate, score } : best;
      }, { index:splitCandidates[0], score:Infinity }).index;
      const columns = document.createElement("div");
      columns.className = "week-columns";
      [groups.slice(0, splitIndex), groups.slice(splitIndex)].forEach(columnGroups => {
        const column = document.createElement("div");
        column.className = "week-column";
        columnGroups.forEach(group => column.appendChild(makeDayGroup(group)));
        columns.appendChild(column);
      });
      el.appendChild(columns);
    }
  }
  scheduleAuxFit();
}
function renderAuxDue() {
  const today = isoDate(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
  const dueItems = tickets.filter(t => !t.archived && t.status !== "완료" && t.dueDate)
    .map(t => ({ t, days: Math.round((new Date(t.dueDate + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000) }))
    .filter(item => item.days <= 3)
    .sort((a, b) => a.days - b.days || updatedMillis(b.t) - updatedMillis(a.t));
  const el = document.getElementById("aux-due-list");
  el.innerHTML = "";
  if (!dueItems.length) {
    el.innerHTML = `<div class="empty-alert">기한 임박 업무가 없습니다</div>`;
    scheduleAuxFit();
    return;
  }
  dueItems.forEach(({ t, days }) => {
    const row = document.createElement("div");
    row.className = "agenda-row";
    const label = days < 0 ? `초과 ${Math.abs(days)}일` : days === 0 ? "오늘" : `D-${days}`;
    const labelClass = days < 0 ? " is-overdue" : days === 0 ? " is-today" : "";
    row.innerHTML = `<span class="due-label${labelClass}">${label}</span><span class="agenda-title">${escapeHtml(t.title || "-")}</span><span class="agenda-assignee">${escapeHtml(t.requestedBy || "-")} → ${escapeHtml(ticketRecipientLabel(t))}</span>`;
    row.addEventListener("click", () => openTicketDetailBoard(t));
    el.appendChild(row);
  });
  scheduleAuxFit();
}
function renderAuxToday() {
  const now = new Date();
  const todayIso = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  const items = schedules.filter(s => Array.isArray(s.dates) && s.dates.includes(todayIso));
  items.sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });
  const el = document.getElementById("aux-today-list");
  el.innerHTML = "";
  el.classList.remove("today-grid");
  el.style.removeProperty("--today-columns");
  if (!items.length) {
    el.innerHTML = `<div class="empty-alert">오늘 일정이 없습니다</div>`;
  } else {
    const columns = items.length === 1 ? 1 : items.length <= 4 ? 2 : 3;
    el.style.setProperty("--today-columns", columns);
    el.classList.add("today-grid");
    items.forEach(s => el.appendChild(buildAgendaRow(s.time || "종일", s)));
  }
  scheduleAuxFit();
}

/* ───────── 메모 상세보기 (미확인 알림 / 완료된 항목 공용) ───────── */
const memoDetailOverlay = document.getElementById("memo-detail-overlay");
function openMemoDetail(group, isDone) {
  document.getElementById("memo-detail-title").textContent = `${group.assignee || "미지정"} - ${group.subject || ""}`;

  const metaLines = [];
  metaLines.push(`긴급도: <b>${topUrgency(group.items)}</b>`);
  metaLines.push(`상태: <b>${isDone ? "확인됨" : "미확인"}</b>`);
  document.getElementById("memo-detail-meta").innerHTML = metaLines.join("<br>");

  const itemsEl = document.getElementById("memo-detail-items");
  itemsEl.innerHTML = "";
  group.items.forEach(m => {
    const div = document.createElement("div");
    div.className = "eh-item";
    div.innerHTML = isDone
      ? `<div class="eh-meta">작성자 ${escapeHtml(m.receivedBy || "-")} · ${fmtTimestamp(m.receivedAt)}</div><div>확인함: ${escapeHtml(m.confirmedBy || "-")} · ${fmtTimestamp(m.confirmedAt)}</div>`
      : `<div class="eh-meta">작성자 ${escapeHtml(m.receivedBy || "-")} · ${fmtTimestamp(m.receivedAt)}</div>`;
    itemsEl.appendChild(div);
  });

  const actionsEl = document.getElementById("memo-detail-actions");
  actionsEl.innerHTML = "";
  if (!isDone) {
    const btn = document.createElement("button");
    btn.id = "memo-detail-confirm-btn";
    btn.textContent = "확인 처리";
    btn.addEventListener("click", () => {
      memoDetailOverlay.classList.remove("open");
      openNameModal(group.items.map(m => m.id));
    });
    actionsEl.appendChild(btn);
  }

  memoDetailOverlay.classList.add("open");
}
document.getElementById("memo-detail-close").addEventListener("click", () => memoDetailOverlay.classList.remove("open"));
memoDetailOverlay.addEventListener("click", (e) => {
  if (e.target === memoDetailOverlay) memoDetailOverlay.classList.remove("open");
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ───────── 이름 선택 모달 ───────── */
let pendingMemoIds = [];
const overlay = document.getElementById("name-modal-overlay");
const nameButtons = document.getElementById("name-buttons");
TEAM_MEMBERS.forEach(name => {
  const btn = document.createElement("button");
  btn.className = "name-btn";
  btn.textContent = name;
  btn.addEventListener("click", () => confirmMemo(name));
  nameButtons.appendChild(btn);
});

function openNameModal(memoIds) {
  pendingMemoIds = Array.isArray(memoIds) ? memoIds : [memoIds];
  document.getElementById("name-modal-sub").textContent =
    pendingMemoIds.length > 1 ? `이 ${pendingMemoIds.length}건을 확인한 사람을 선택하세요` : "이 항목을 확인한 사람을 선택하세요";
  overlay.style.display = "flex";
}
document.getElementById("name-cancel").addEventListener("click", () => {
  overlay.style.display = "none";
  pendingMemoIds = [];
});

async function confirmMemo(name) {
  if (!pendingMemoIds.length) return;
  for (const id of pendingMemoIds) {
    await updateDoc(doc(db, "phoneMemos", id), {
      status: "확인됨",
      confirmedBy: name,
      confirmedAt: serverTimestamp()
    });
  }
  overlay.style.display = "none";
  pendingMemoIds = [];
}

/* 24시간 경과 여부는 시간 흐름에 따라 바뀌므로 주기적으로 다시 렌더 */
setInterval(renderAlerts, 60000);

/* ── 전자칠판 자동 새로고침 ──────────────────────────────
   이 화면은 대형 모니터에 항상 띄워두는 용도. Firestore 데이터(일정/업무/메모)는
   onSnapshot으로 실시간 반영되지만, 화면 디자인·기능이 바뀐 새 코드는 브라우저 탭을
   직접 새로고침하기 전까지 반영되지 않음. 화면에 열려있는 팝업이 없을 때에 한해
   일정 시간마다 자동으로 새로고침해서 항상 최신 코드/연결 상태를 유지함 */
const AUTO_RELOAD_CHECK_MS = 5 * 60 * 1000;   // 5분마다 새로고침 가능 여부 확인
function anyOverlayOpen() {
  return dayDetailOverlay.classList.contains("open")
    || eventDetailOverlay.classList.contains("open")
    || memoDetailOverlay.classList.contains("open")
    || overlay.style.display === "flex";
}
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 4 && now.getMinutes() < 5 && !anyOverlayOpen()) {
    location.reload();
  }
}, AUTO_RELOAD_CHECK_MS);

/* ── 번인(burn-in) 방지: 픽셀 시프트 ──────────────────────
   상단바/캘린더 격자선처럼 하루 종일 같은 자리에 떠 있는 요소가 계속 정확히 같은
   픽셀 위치에 고정되면 화면에 옅게 눌어붙는 잔상(번인)이 생길 수 있음.
   화면 전체를 몇 분마다 1~2px씩, 사람 눈에 안 보일 만큼 미세하게 살짝 이동시켜
   같은 픽셀이 계속 켜져 있지 않도록 함 */
const BURNIN_SHIFT_INTERVAL_MS = 3 * 60 * 1000; // 3분마다 위치를 살짝 바꿈
const BURNIN_SHIFT_OFFSETS = [
  [0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]
];
let burninShiftIdx = 0;
const appEl = document.getElementById("app");
setInterval(() => {
  burninShiftIdx = (burninShiftIdx + 1) % BURNIN_SHIFT_OFFSETS.length;
  const [dx, dy] = BURNIN_SHIFT_OFFSETS[burninShiftIdx];
  appEl.style.transform = `translate(${dx}px, ${dy}px)`;
}, BURNIN_SHIFT_INTERVAL_MS);

/* ───────── 전자칠판 보조화면 자동 전환 (30분마다 5분씩 표출, 번인 방지) ───────── */
const topbarEl = document.getElementById("topbar");
const mainEl = document.getElementById("main");
const auxScreenEl = document.getElementById("aux-screen");
const AUX_CYCLE_MS = 30 * 60 * 1000;   // 30분마다
const AUX_DURATION_MS = 5 * 60 * 1000; // 5분간 표출
let auxCycleTimeoutId = null;
let auxDurationTimeoutId = null;
let clockOnlyTimeoutId = null;
let auxFitFrame = null;

function auxListUnits(id) {
  const list = document.getElementById(id);
  const weekColumns = list.querySelector(".week-columns");
  if (weekColumns) {
    const columnLoads = [...weekColumns.querySelectorAll(".week-column")].map(column =>
      column.querySelectorAll(".agenda-row").length + column.querySelectorAll(".agenda-day-group").length * 0.7
    );
    return Math.max(...columnLoads, 0.5);
  }
  if (list.classList.contains("today-grid")) {
    const columns = Number(list.style.getPropertyValue("--today-columns")) || 1;
    return Math.ceil(list.querySelectorAll(".agenda-row").length / columns) * 1.25 + 0.5;
  }
  return [...list.children].reduce((sum, child) => {
    if (child.classList.contains("agenda-day-group")) return sum + 0.7 + child.querySelectorAll(".agenda-row").length;
    if (child.classList.contains("empty-alert")) return sum + 0.7;
    return sum + 1.25;
  }, 0.5);
}
function auxPanelNaturalHeight(id) {
  const panel = document.getElementById(id);
  const heading = panel.querySelector("h3");
  const list = panel.querySelector("[id$='-list']");
  return (heading?.offsetHeight || 0) + (list?.scrollHeight || 0) + 2;
}
function maximizeAuxPanelFont(panelId, listId) {
  const panel = document.getElementById(panelId);
  const list = document.getElementById(listId);
  const row = list.querySelector(".agenda-row");
  if (!row || list.clientHeight <= 0) return;
  const baseSize = Math.max(9, parseFloat(getComputedStyle(row).fontSize) || 13);
  let bestSize = baseSize;
  for (let size = Math.ceil(baseSize) + 1; size <= 21; size++) {
    panel.style.setProperty("--aux-font", `${size}px`);
    void list.offsetHeight;
    if (list.scrollHeight > list.clientHeight + 1) break;
    bestSize = size;
  }
  panel.style.setProperty("--aux-font", `${bestSize}px`);
}
function fitAuxLayout() {
  auxFitFrame = null;
  if (auxScreenEl.style.display !== "flex" || auxScreenEl.classList.contains("clock-only-mode")) return;
  const body = document.getElementById("aux-body");
  ["aux-week-col", "aux-today-section"].forEach(id => document.getElementById(id).style.removeProperty("--aux-font"));
  const alertUnits = auxListUnits("aux-alert-list");
  const weekUnits = auxListUnits("aux-week-list");
  const dueUnits = auxListUnits("aux-due-list");
  const todayUnits = auxListUnits("aux-today-list");
  const leftWeight = Math.max(alertUnits, dueUnits);
  const rightWeight = Math.max(weekUnits, todayUnits);
  const columnRatio = Math.min(0.78, Math.max(0.22, leftWeight / Math.max(1, leftWeight + rightWeight)));
  body.style.gridTemplateColumns = `minmax(0, ${columnRatio.toFixed(3)}fr) minmax(0, ${(1 - columnRatio).toFixed(3)}fr)`;

  const densityClasses = ["aux-density-1", "aux-density-2", "aux-density-3", "aux-density-4"];
  auxScreenEl.classList.remove(...densityClasses);
  void body.offsetHeight;
  const topNeed = Math.max(auxPanelNaturalHeight("aux-alert-col"), auxPanelNaturalHeight("aux-week-col"));
  const bottomNeed = Math.max(auxPanelNaturalHeight("aux-due-section"), auxPanelNaturalHeight("aux-today-section"));
  const rowRatio = Math.min(0.84, Math.max(0.16, topNeed / Math.max(1, topNeed + bottomNeed)));
  body.style.gridTemplateRows = `minmax(0, ${rowRatio.toFixed(3)}fr) minmax(0, ${(1 - rowRatio).toFixed(3)}fr)`;

  const listIds = ["aux-alert-list", "aux-week-list", "aux-due-list", "aux-today-list"];
  const densities = ["", ...densityClasses];
  for (const density of densities) {
    auxScreenEl.classList.remove(...densityClasses);
    if (density) auxScreenEl.classList.add(density);
    void body.offsetHeight;
    const fits = listIds.every(id => {
      const list = document.getElementById(id);
      return list.scrollHeight <= list.clientHeight + 1;
    });
    if (fits) break;
  }
  maximizeAuxPanelFont("aux-week-col", "aux-week-list");
  maximizeAuxPanelFont("aux-today-section", "aux-today-list");
}
function scheduleAuxFit() {
  if (auxFitFrame) cancelAnimationFrame(auxFitFrame);
  auxFitFrame = requestAnimationFrame(fitAuxLayout);
}
window.addEventListener("resize", scheduleAuxFit);

function showAuxScreen({ clockOnly = false } = {}) {
  auxScreenEl.classList.toggle("clock-only-mode", clockOnly);
  if (!clockOnly) {
    renderAuxWeek();
    renderAuxDue();
    renderAuxToday();
  }
  topbarEl.classList.add("fade-out");
  mainEl.classList.add("fade-out");
  setTimeout(() => {
    topbarEl.style.display = "none";
    mainEl.style.display = "none";
    auxScreenEl.style.display = "flex";
    auxScreenEl.classList.add("fade-out");
    void auxScreenEl.offsetHeight;
    auxScreenEl.classList.remove("fade-out");
    auxScreenEl.focus({ preventScroll:true });
    scheduleAuxFit();
  }, 600);
}
function showMainScreen() {
  auxScreenEl.classList.add("fade-out");
  setTimeout(() => {
    auxScreenEl.style.display = "none";
    auxScreenEl.classList.remove("clock-only-mode");
    topbarEl.style.display = "grid";
    mainEl.style.display = "flex";
    requestAnimationFrame(fitCalendarDensity);
    topbarEl.classList.add("fade-out");
    mainEl.classList.add("fade-out");
    void topbarEl.offsetHeight;
    void mainEl.offsetHeight;
    topbarEl.classList.remove("fade-out");
    mainEl.classList.remove("fade-out");
  }, 600);
}
function scheduleAuxCycle() {
  if (auxCycleTimeoutId) clearTimeout(auxCycleTimeoutId);
  auxCycleTimeoutId = setTimeout(() => {
    showAuxScreen();
    auxDurationTimeoutId = setTimeout(returnToMainScreen, AUX_DURATION_MS);
  }, AUX_CYCLE_MS);
}
function returnToMainScreen() {
  if (auxDurationTimeoutId) { clearTimeout(auxDurationTimeoutId); auxDurationTimeoutId = null; }
  if (clockOnlyTimeoutId) { clearTimeout(clockOnlyTimeoutId); clockOnlyTimeoutId = null; }
  showMainScreen();
  scheduleAuxCycle();
}
auxScreenEl.addEventListener("click", event => {
  if (auxScreenEl.style.display !== "flex") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  returnToMainScreen();
}, true);
auxScreenEl.addEventListener("keydown", event => {
  if (["Enter", " ", "Escape"].includes(event.key)) { event.preventDefault(); returnToMainScreen(); }
});
/* 자동 전환 시간이 아니어도 언제든 수동으로 미리보기 가능 */
document.getElementById("aux-preview-btn").addEventListener("click", () => {
  if (auxCycleTimeoutId) clearTimeout(auxCycleTimeoutId);
  if (auxDurationTimeoutId) { clearTimeout(auxDurationTimeoutId); auxDurationTimeoutId = null; }
  showAuxScreen();
});
scheduleAuxCycle();

function showClockOnlyMoment(now = new Date()) {
  if (auxCycleTimeoutId) { clearTimeout(auxCycleTimeoutId); auxCycleTimeoutId = null; }
  if (auxDurationTimeoutId) { clearTimeout(auxDurationTimeoutId); auxDurationTimeoutId = null; }
  if (clockOnlyTimeoutId) clearTimeout(clockOnlyTimeoutId);
  showAuxScreen({ clockOnly:true });
  const untilNextMinute = Math.max(1000, (60 - now.getSeconds()) * 1000 - now.getMilliseconds());
  clockOnlyTimeoutId = setTimeout(returnToMainScreen, untilNextMinute);
}
let lastClockOnlyMoment = "";
let lastHourlyAnnouncement = "";
function handleTimedBoardEvents() {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
  if (now.getMinutes() === 0) {
    const hourKey = `${dateKey}-${now.getHours()}`;
    if (hourKey !== lastHourlyAnnouncement) {
      lastHourlyAnnouncement = hourKey;
      speakHourlyTime(now);
    }
  }
  if (now.getHours() === 17 && now.getMinutes() === 26) {
    const momentKey = `${dateKey}-1726`;
    if (momentKey !== lastClockOnlyMoment) {
      lastClockOnlyMoment = momentKey;
      playBoardChime();
      showClockOnlyMoment(now);
    }
  }
}
handleTimedBoardEvents();
setInterval(handleTimedBoardEvents, 1000);

/* 팝업은 ESC로 닫고, 열린 동안 키보드 포커스가 팝업 안에 머물도록 한다. */
const boardOverlays = [dayDetailOverlay, eventDetailOverlay, memoDetailOverlay, document.getElementById("name-modal-overlay")];
const boardReturnFocus = new WeakMap();
boardOverlays.forEach(overlay => {
  new MutationObserver(() => {
    const open = overlay.classList.contains("open") || getComputedStyle(overlay).display === "flex";
    if (open && !boardReturnFocus.has(overlay)) {
      boardReturnFocus.set(overlay, document.activeElement);
      overlay.querySelector("button, [tabindex='-1']")?.focus();
    } else if (!open && boardReturnFocus.has(overlay)) {
      const previous = boardReturnFocus.get(overlay);
      if (previous && document.contains(previous)) previous.focus();
      boardReturnFocus.delete(overlay);
    }
  }).observe(overlay, { attributes:true, attributeFilter:["class", "style"] });
});
document.addEventListener("keydown", e => {
  const openOverlay = boardOverlays.find(overlay => overlay.classList.contains("open") || getComputedStyle(overlay).display === "flex");
  if (!openOverlay) return;
  if (e.key === "Escape") {
    openOverlay.classList.remove("open");
    if (openOverlay.id === "name-modal-overlay") openOverlay.style.display = "none";
    const previous = boardReturnFocus.get(openOverlay);
    if (previous && document.contains(previous)) previous.focus();
    boardReturnFocus.delete(openOverlay);
    return;
  }
  if (e.key !== "Tab") return;
  const focusable = [...openOverlay.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter(el => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

renderCalendar();
