import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp } from "firebase/firestore";

let env;
const profiles = {
  u1: { name:"강은석", email:"kw5232@naver.com", role:"member" },
  u2: { name:"박재현", email:"parkjh8372@naver.com", role:"member" },
  admin: { name:"관리자", email:"yakolibre@gmail.com", role:"admin" }
};

before(async () => {
  env = await initializeTestEnvironment({
    projectId:"demo-smc-fm",
    firestore:{ rules:readFileSync("firestore.rules", "utf8") }
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    for (const [uid, profile] of Object.entries(profiles)) {
      await setDoc(doc(context.firestore(), "users", uid), profile);
    }
  });
});

after(async () => env.cleanup());

function dbWith(uid, email) {
  return env.authenticatedContext(uid, email ? { email } : {}).firestore();
}
function dbAs(uid) { return dbWith(uid, profiles[uid].email); }
function anonDb(uid = "anonymous-board") { return dbWith(uid, null); }
async function seed(path, data) {
  await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), ...path.split("/")), data));
}

function scheduleData(overrides = {}) {
  return {
    title:"점검", type:"업무", dates:["2026-07-15"], months:["2026-07"],
    responsible:["강은석"], responsibleUids:["u1"], registeredBy:"강은석", registeredByUid:"u1",
    registeredAt:serverTimestamp(), updatedAt:serverTimestamp(), archived:false, ...overrides
  };
}

function ticketData(overrides = {}) {
  return {
    title:"점검 요청", requestedBy:"강은석", requestedByUid:"u1", participants:["강은석","박재현"],
    participantUids:["u1","u2"], assignee:"박재현", assigneeUid:"u2", status:"미수신",
    requestedAt:serverTimestamp(), updatedAt:serverTimestamp(), archived:false, ...overrides
  };
}

test("사용자는 자신의 이름·이메일·역할을 바꿀 수 없다", async () => {
  const own = doc(dbAs("u1"), "users", "u1");
  await assertFails(updateDoc(own, { name:"박재현" }));
  await assertFails(updateDoc(own, { email:"other@example.com" }));
  await assertFails(updateDoc(own, { role:"admin" }));
  await assertSucceeds(updateDoc(own, { active:true, updatedAt:serverTimestamp() }));
});

test("신규 사용자 프로필은 등록 이메일과 고정 이름을 따라야 한다", async () => {
  const newUserDb = dbWith("u3", "bosun1245@daum.net");
  await assertSucceeds(setDoc(doc(newUserDb, "users", "u3"), {
    name:"강보선", loginId:"강보선", email:"bosun1245@daum.net", role:"member", active:true
  }));
  await assertFails(setDoc(doc(dbWith("u4", "unknown@example.com"), "users", "u4"), {
    name:"관리자", email:"unknown@example.com", role:"admin"
  }));
});

test("관련업무 생성자는 자신의 UID와 이름을 위조할 수 없다", async () => {
  await assertSucceeds(setDoc(doc(dbAs("u1"), "requestTickets", "t1"), ticketData()));
  await assertFails(setDoc(doc(dbAs("u2"), "requestTickets", "t2"), ticketData({ requestedBy:"강은석", requestedByUid:"u1" })));
  await assertFails(setDoc(doc(dbAs("u1"), "requestTickets", "t3"), ticketData({ title:"", participantUids:["u1"] })));
});

test("관련업무 참여자는 상태만, 작성자는 원문과 자료보관까지 변경한다", async () => {
  await seed("requestTickets/t1", ticketData());
  await assertSucceeds(updateDoc(doc(dbAs("u2"), "requestTickets", "t1"), {
    status:"진행중", receivedBy:"박재현", receivedAt:serverTimestamp(), updatedAt:serverTimestamp()
  }));
  await assertFails(updateDoc(doc(dbAs("u2"), "requestTickets", "t1"), { title:"무단 수정" }));
  await assertFails(updateDoc(doc(dbAs("u2"), "requestTickets", "t1"), { archived:true, archivedBy:"박재현" }));
  await assertSucceeds(updateDoc(doc(dbAs("u1"), "requestTickets", "t1"), {
    title:"작성자 수정", archived:true, archivedAt:serverTimestamp(), archivedBy:"강은석", archivedByUid:"u1"
  }));
});

test("관련업무 세부사항은 참여자만 읽고 작성자만 수정한다", async () => {
  await seed("requestTickets/t1", ticketData());
  await assertSucceeds(setDoc(doc(dbAs("u2"), "requestTickets", "t1", "details", "d1"), {
    text:"처리 의견", author:"박재현", authorUid:"u2", createdAt:serverTimestamp(), archived:false
  }));
  await assertSucceeds(getDoc(doc(dbAs("u1"), "requestTickets", "t1", "details", "d1")));
  await assertSucceeds(updateDoc(doc(dbAs("u2"), "requestTickets", "t1", "details", "d1"), {
    text:"수정 의견", editedAt:serverTimestamp()
  }));
  await assertFails(updateDoc(doc(dbAs("u1"), "requestTickets", "t1", "details", "d1"), { text:"타인 수정" }));
  await assertFails(getDoc(doc(anonDb(), "requestTickets", "t1", "details", "d1")));
});

test("일정 작성자는 수정·자료보관 가능하고 다른 사용자는 원문을 수정할 수 없다", async () => {
  const ownerDb = dbAs("u1");
  const schedule = doc(ownerDb, "schedules", "s1");
  await assertSucceeds(setDoc(schedule, scheduleData()));
  await assertSucceeds(updateDoc(schedule, { title:"수정된 점검", updatedAt:serverTimestamp() }));
  await assertFails(updateDoc(doc(dbAs("u2"), "schedules", "s1"), { title:"무단 수정" }));
  await assertFails(updateDoc(doc(dbAs("u2"), "schedules", "s1"), { archived:true, archivedBy:"박재현" }));
  await assertSucceeds(updateDoc(schedule, {
    archived:true, archivedAt:serverTimestamp(), archivedBy:"강은석", archivedByUid:"u1", updatedAt:serverTimestamp()
  }));
});

test("일정 세부사항은 작성자가 자신의 내용만 수정·보관한다", async () => {
  await seed("schedules/s1", scheduleData());
  const detail = doc(dbAs("u2"), "schedules", "s1", "details", "d1");
  await assertSucceeds(setDoc(detail, {
    text:"현장 의견", author:"박재현", authorUid:"u2", createdAt:serverTimestamp(), archived:false
  }));
  await assertSucceeds(updateDoc(detail, { text:"수정 의견", editedAt:serverTimestamp() }));
  await assertSucceeds(updateDoc(detail, {
    archived:true, archivedAt:serverTimestamp(), archivedBy:"박재현", archivedByUid:"u2"
  }));
  await assertFails(updateDoc(doc(dbAs("u1"), "schedules", "s1", "details", "d1"), { text:"타인 수정" }));
});

test("메모 담당자는 상태만 변경하고 원문은 작성자만 수정한다", async () => {
  await seed("phoneMemos/m1", {
    subject:"전화", urgency:"중", receivedBy:"강은석", createdByName:"강은석", createdByUid:"u1",
    assignee:"박재현", assigneeUid:"u2", status:"미확인", archived:false
  });
  await assertSucceeds(updateDoc(doc(dbAs("u2"), "phoneMemos", "m1"), {
    status:"확인됨", confirmedBy:"박재현", confirmedAt:serverTimestamp(), updatedAt:serverTimestamp()
  }));
  await assertFails(updateDoc(doc(dbAs("u2"), "phoneMemos", "m1"), { subject:"무단 변경" }));
  await assertSucceeds(updateDoc(doc(dbAs("u1"), "phoneMemos", "m1"), { subject:"작성자 변경" }));
});

test("익명 전자칠판은 원본 생성·삭제·본문 수정 없이 메모 확인 필드만 바꾼다", async () => {
  await seed("schedules/s1", scheduleData());
  await seed("requestTickets/t1", ticketData());
  await seed("phoneMemos/m1", {
    subject:"전화", urgency:"중", createdByName:"강은석", createdByUid:"u1", assignee:"박재현", assigneeUid:"u2", status:"미확인"
  });
  const board = anonDb();
  await assertSucceeds(getDoc(doc(board, "schedules", "s1")));
  await assertSucceeds(getDoc(doc(board, "requestTickets", "t1")));
  await assertFails(setDoc(doc(board, "schedules", "s2"), scheduleData()));
  await assertFails(updateDoc(doc(board, "requestTickets", "t1"), { status:"완료" }));
  await assertFails(updateDoc(doc(board, "phoneMemos", "m1"), { subject:"무단 변경" }));
  await assertSucceeds(updateDoc(doc(board, "phoneMemos", "m1"), {
    status:"확인됨", confirmedBy:"전자칠판", confirmedAt:serverTimestamp()
  }));
  await assertFails(deleteDoc(doc(board, "phoneMemos", "m1")));
});

test("사용자별 알림은 수신자와 관리자만 읽고 수정한다", async () => {
  await assertSucceeds(setDoc(doc(dbAs("u1"), "userNotifications", "u2", "items", "n1"), {
    recipientUid:"u2", recipientName:"박재현", actorUid:"u1", actorName:"강은석", message:"확인 요청"
  }));
  await assertFails(getDoc(doc(dbAs("u1"), "userNotifications", "u2", "items", "n1")));
  await assertSucceeds(getDoc(doc(dbAs("u2"), "userNotifications", "u2", "items", "n1")));
  await assertSucceeds(updateDoc(doc(dbAs("u2"), "userNotifications", "u2", "items", "n1"), { readAt:serverTimestamp() }));
  await assertSucceeds(getDoc(doc(dbAs("admin"), "userNotifications", "u2", "items", "n1")));
});

test("감사기록은 행위자 검증 후 생성되고 누구도 수정하지 못한다", async () => {
  const log = doc(dbAs("u1"), "auditLogs", "a1");
  await assertSucceeds(setDoc(log, {
    actorUid:"u1", actorName:"강은석", action:"schedule_updated", targetCollection:"schedules", targetId:"s1",
    createdAt:serverTimestamp()
  }));
  await assertFails(setDoc(doc(dbAs("u2"), "auditLogs", "a2"), {
    actorUid:"u1", actorName:"강은석", action:"forged", createdAt:serverTimestamp()
  }));
  await assertFails(getDoc(log));
  await assertSucceeds(getDoc(doc(dbAs("admin"), "auditLogs", "a1")));
  await assertFails(updateDoc(doc(dbAs("admin"), "auditLogs", "a1"), { action:"changed" }));
  await assertFails(deleteDoc(doc(dbAs("admin"), "auditLogs", "a1")));
});

test("공휴일과 시스템 설정은 관리자만 변경한다", async () => {
  await seed("customHolidays/2026-07-17", { name:"제헌절" });
  await assertSucceeds(getDoc(doc(dbAs("u1"), "customHolidays", "2026-07-17")));
  await assertFails(updateDoc(doc(dbAs("u1"), "customHolidays", "2026-07-17"), { name:"변조" }));
  await assertSucceeds(updateDoc(doc(dbAs("admin"), "customHolidays", "2026-07-17"), { name:"제헌절" }));
  await assertFails(setDoc(doc(dbAs("u1"), "system", "app"), { schemaVersion:3 }));
  await assertSucceeds(setDoc(doc(dbAs("admin"), "system", "app"), { schemaVersion:2 }));
});

test("문서 영구삭제는 관리자만 가능하다", async () => {
  await seed("schedules/s1", { title:"x" });
  await assertFails(deleteDoc(doc(dbAs("u1"), "schedules", "s1")));
  await assertSucceeds(deleteDoc(doc(dbAs("admin"), "schedules", "s1")));
  assert.equal((await getDoc(doc(dbAs("admin"), "schedules", "s1"))).exists(), false);
});
