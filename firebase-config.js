// 공유 Firebase 초기화 모듈
// board.html, input.html 양쪽에서 import 해서 사용합니다.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  setDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  Timestamp,
  getDocs,
  limit,
  startAfter
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAVWJcGbB8d6En2OFJ9mvb9wKylhucklOE",
  authDomain: "smc-fm.firebaseapp.com",
  projectId: "smc-fm",
  storageBucket: "smc-fm.firebasestorage.app",
  messagingSenderId: "549534317636",
  appId: "1:549534317636:web:b93a92bb32e6af966e1011",
  measurementId: "G-CVD74C4KVC"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// 팀원 목록 (고정 초기값, 필요 시 여기 배열만 수정하면 전체 화면에 반영됨)
export const TEAM_MEMBERS = ["강보선", "강은석", "박재현", "김준형", "김류현", "관리자"];

export const ACCESS_CODE = "3813";

// 관리자(admin.html) 전용 비밀번호 - 팀 접근코드와 별개로 한 번 더 확인
export const ADMIN_PASSWORD = "mm976456";

// 대한민국 법정 공휴일 (관공서의 공휴일에 관한 규정 기준, 대체공휴일 포함)
// ※ 2025·2026년은 확정 고시 기준, 2027년은 (음력 환산 및 현행 대체공휴일 규정 기준) 예상치이므로
//   정부 관보 고시 이후 필요 시 아래 표만 갱신하면 됩니다.
export const KR_HOLIDAYS = {
  "2025-01-01": "신정",
  "2025-01-27": "임시공휴일",
  "2025-01-28": "설날연휴",
  "2025-01-29": "설날",
  "2025-01-30": "설날연휴",
  "2025-03-01": "삼일절",
  "2025-03-03": "대체공휴일(삼일절)",
  "2025-05-05": "어린이날·부처님오신날",
  "2025-05-06": "대체공휴일(부처님오신날)",
  "2025-06-06": "현충일",
  "2025-08-15": "광복절",
  "2025-10-03": "개천절",
  "2025-10-05": "추석연휴",
  "2025-10-06": "추석",
  "2025-10-07": "추석연휴",
  "2025-10-08": "대체공휴일(추석)",
  "2025-10-09": "한글날",
  "2025-12-25": "크리스마스",

  "2026-01-01": "신정",
  "2026-02-16": "설날연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날연휴",
  "2026-03-01": "삼일절",
  "2026-03-02": "대체공휴일(삼일절)",
  "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일(부처님오신날)",
  "2026-06-06": "현충일",
  "2026-07-17": "제헌절",
  "2026-08-15": "광복절",
  "2026-08-17": "대체공휴일(광복절)",
  "2026-09-24": "추석연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석연휴",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일(개천절)",
  "2026-10-09": "한글날",
  "2026-12-25": "크리스마스",

  "2027-01-01": "신정",
  "2027-02-06": "설날연휴",
  "2027-02-07": "설날",
  "2027-02-08": "설날연휴",
  "2027-02-09": "대체공휴일(설날)",
  "2027-03-01": "삼일절",
  "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날",
  "2027-06-06": "현충일",
  "2027-07-17": "제헌절",
  "2027-07-19": "대체공휴일(제헌절)",
  "2027-08-15": "광복절",
  "2027-08-16": "대체공휴일(광복절)",
  "2027-09-14": "추석연휴",
  "2027-09-15": "추석",
  "2027-09-16": "추석연휴",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일(개천절)",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일(한글날)",
  "2027-12-25": "크리스마스",
  "2027-12-27": "대체공휴일(크리스마스)"
};

export {
  db, auth,
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp, Timestamp,
  signInAnonymously, onAuthStateChanged, getDocs, limit, startAfter
};
