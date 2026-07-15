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
  env = await initializeTestEnvironment({ projectId:"demo-smc-fm", firestore:{ rules:readFileSync("firestore.rules", "utf8") } });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    for (const [uid, profile] of Object.entries(profiles)) await setDoc(doc(context.firestore(), "users", uid), profile);
  });
});
after(async () => env.cleanup());

function dbAs(uid) { return env.authenticatedContext(uid, { email:profiles[uid].email }).firestore(); }

test("사용자는 자신의 이름과 역할을 바꿀 수 없다", async () => {
  await assertFails(updateDoc(doc(dbAs("u1"), "users", "u1"), { name:"박재현" }));
  await assertFails(updateDoc(doc(dbAs("u1"), "users", "u1"), { role:"admin" }));
  await assertSucceeds(updateDoc(doc(dbAs("u1"), "users", "u1"), { active:true, updatedAt:serverTimestamp() }));
});

test("일정 작성자는 수정·자료보관 가능하고 다른 사용자는 원문을 수정할 수 없다", async () => {
  const ownerDb = dbAs("u1");
  const schedule = doc(ownerDb, "schedules", "s1");
  await assertSucceeds(setDoc(schedule, {
    title:"점검", type:"업무", dates:["2026-07-15"], months:["2026-07"], responsible:["강은석"], responsibleUids:["u1"],
    registeredBy:"강은석", registeredByUid:"u1", registeredAt:serverTimestamp(), updatedAt:serverTimestamp(), archived:false
  }));
  await assertSucceeds(updateDoc(schedule, { title:"수정된 점검", updatedAt:serverTimestamp() }));
  await assertFails(updateDoc(doc(dbAs("u2"), "schedules", "s1"), { title:"무단 수정" }));
  await assertSucceeds(setDoc(doc(dbAs("u2"), "schedules", "s1", "details", "d1"), {
    text:"의견", author:"박재현", authorUid:"u2", createdAt:serverTimestamp(), archived:false
  }));
  await assertFails(updateDoc(doc(dbAs("u2"), "schedules", "s1"), { archived:true, archivedBy:"박재현" }));
  await assertSucceeds(updateDoc(schedule, { archived:true, archivedAt:serverTimestamp(), archivedBy:"강은석", archivedByUid:"u1", updatedAt:serverTimestamp() }));
});

test("메모 담당자는 상태만 변경하고 원문은 작성자만 수정한다", async () => {
  await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), "phoneMemos", "m1"), {
    subject:"전화", urgency:"중", receivedBy:"강은석", createdByName:"강은석", createdByUid:"u1",
    assignee:"박재현", assigneeUid:"u2", status:"미확인", archived:false
  }));
  await assertSucceeds(updateDoc(doc(dbAs("u2"), "phoneMemos", "m1"), { status:"확인됨", confirmedBy:"박재현", confirmedAt:serverTimestamp(), updatedAt:serverTimestamp() }));
  await assertFails(updateDoc(doc(dbAs("u2"), "phoneMemos", "m1"), { subject:"무단 변경" }));
  await assertSucceeds(updateDoc(doc(dbAs("u1"), "phoneMemos", "m1"), { subject:"작성자 변경" }));
});

test("문서 영구삭제는 관리자만 가능하다", async () => {
  await env.withSecurityRulesDisabled(async context => setDoc(doc(context.firestore(), "schedules", "s1"), { title:"x" }));
  await assertFails(deleteDoc(doc(dbAs("u1"), "schedules", "s1")));
  await assertSucceeds(deleteDoc(doc(dbAs("admin"), "schedules", "s1")));
  assert.equal((await getDoc(doc(dbAs("admin"), "schedules", "s1"))).exists(), false);
});
