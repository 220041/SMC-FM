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
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  Timestamp
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
export const TEAM_MEMBERS = ["강보선", "강은석", "박재현", "김준형", "김류현"];

export const ACCESS_CODE = "3813";

export {
  db, auth,
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, Timestamp,
  signInAnonymously, onAuthStateChanged
};
