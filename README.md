# 서귀포의료원 시설관리팀 업무공유 시스템

시설관리팀 5명과 관리자 1명이 사용하는 정적 웹앱입니다. 화면은 GitHub Pages에서 제공하고, 인증과 데이터 저장은 Firebase Authentication·Cloud Firestore를 사용합니다.

## 화면 구성

- `index.html`: 시작 화면
- `input.html`: 사용자 대시보드, 관련업무, 일정, 메모
- `board.html`: 전자칠판 월간일정과 보조화면
- `orders.html`: 계약팀 Google Sheet 조회 화면
- `admin.html`: 관리자 편집, 자료보관, 사용자, 백업·복구, 데이터 관리

공용 코드는 `firebase-config.js`, `account-auth.js`, `auth-gate.js`, `app-runtime.js`, `data-model.js`, `common.css`에 있습니다.

## 인증 계정

Firebase Console → Authentication → Sign-in method에서 Email/Password와 Anonymous 로그인을 활성화합니다.

| 로그인 아이디 | Firebase 이메일 | 역할 |
|---|---|---|
| 강은석 | kw5232@naver.com | member |
| 박재현 | parkjh8372@naver.com | member |
| 강보선 | bosun1245@daum.net | member |
| 김류현 | kimwimi23@naver.com | member |
| 김준형 | 220041@naver.com | member |
| admin | yakolibre@gmail.com | admin |

초기 비밀번호는 Firebase Console에서 `123456`으로 만들며, 최초 로그인 시 다른 6자리 이상의 비밀번호로 변경합니다. 사용자가 처음 로그인하면 `users/{uid}` 프로필이 생성됩니다. 관리자 프로필은 Firestore Console에서 `role`을 `admin`으로 한 번 변경해야 합니다.

전자칠판은 `3813` 접근코드와 Firebase 익명 인증을 그대로 사용합니다. 접근코드는 보안 비밀번호가 아니라 화면 진입 장벽이며 배포된 자바스크립트에서 확인할 수 있습니다.

## 권한 원칙

- 작성자는 자신이 만든 관련업무·일정·메모의 원문을 수정하고 자료보관으로 이동할 수 있습니다.
- 다른 사용자는 관련업무 상태, 허용된 세부사항, 삭제 요청만 변경할 수 있습니다.
- 일정 세부사항은 로그인 사용자라면 추가할 수 있고 본인이 쓴 내용만 수정·보관할 수 있습니다.
- 메모 담당자는 확인 상태만 변경할 수 있습니다.
- 사용자의 삭제는 실제 삭제가 아니라 `archived: true` 자료보관입니다.
- 영구삭제, 복원, 전체 백업·복구는 관리자만 가능합니다.
- 전자칠판 익명 계정은 자료를 읽고 메모 확인 필드만 변경할 수 있습니다.

실제 권한은 `firestore.rules`에서 강제합니다. 화면 버튼을 숨기는 것만으로 권한을 판단하지 않습니다.

## Firestore 주요 구조

```text
users/{uid}
requestTickets/{ticketId}
requestTickets/{ticketId}/details/{detailId}
schedules/{scheduleId}
schedules/{scheduleId}/details/{detailId}
phoneMemos/{memoId}
userNotifications/{uid 또는 기존 이름}/items/{notificationId}
auditLogs/{logId}
customHolidays/{yyyy-mm-dd}
system/app
```

새 문서는 UID 필드를 기준으로 연결하며 기존 문서는 이름 필드를 임시 호환합니다. 관리자 → 자료보관 → `기존 데이터 구조 보완`을 실행하면 기존 자료에 UID, 일정 월 검색 필드, 스키마 버전을 추가합니다. 이 작업이 끝나면 전자칠판은 현재 표시 월 중심으로 일정을 조회합니다.

## 최초 배포 및 업데이트

Firebase CLI를 설치하고 로그인한 뒤 다음을 실행합니다.

보안 규칙 에뮬레이터 테스트에는 Java 11 이상이 필요합니다.

```bash
npm install
firebase login
firebase use smc-fm
npm run test:rules
firebase deploy --only firestore:rules,firestore:indexes
```

CLI를 사용하지 않으면 `firestore.rules` 내용을 Firebase Console → Firestore Database → Rules에 붙여넣어 게시할 수 있습니다. 규칙 배포 후 관리자 페이지에서 다음 순서로 실행합니다.

1. 전체 JSON 백업
2. 기존 데이터 구조 보완
3. 자료보관 조회와 일정·메모 정상 표시 확인

정적 화면 파일은 기존 GitHub Pages 저장소에 업로드합니다.

## 백업과 복구

관리자 → 자료보관 → 데이터 관리에서 실행합니다.

- `전체 JSON 백업`: 상위 컬렉션, 관련업무·일정 세부사항, 알림, 감사기록을 한 파일로 저장
- `백업 복구`: 같은 문서 ID는 병합 갱신하고 없는 문서는 생성
- `90일 지난 읽은 알림 정리`: 화면에 더 이상 필요 없는 읽은 알림을 최대 300건씩 정리

복구 전에 현재 데이터를 한 번 더 백업해야 합니다. 백업 파일에는 업무 내용과 사용자 정보가 포함되므로 외부 공유 폴더에 두지 않습니다.

## 운영 점검

- Firebase Console의 Firestore Usage에서 읽기·쓰기 사용량을 주기적으로 확인합니다.
- 화면 오른쪽 아래 `오프라인` 표시가 장시간 유지되면 네트워크와 Firebase 상태를 확인합니다.
- 매월 1회 JSON 백업을 내려받아 내부 저장소에 보관합니다.
- 인원이나 이메일이 바뀌면 `firebase-config.js`의 `TEAM_MEMBERS`, `USER_ACCOUNTS`와 `firestore.rules`의 이메일-이름 매핑을 함께 수정합니다.
- 공휴일 기본 데이터 이후 연도는 관리자 공휴일 관리에서 추가합니다.

## 발주현황 주의사항

`orders.html`은 Google Sheet CSV URL을 직접 읽는 현재 방식을 유지합니다. 시트가 링크 공개 상태라면 앱 로그인과 무관하게 URL을 아는 사용자가 볼 수 있으므로 공유 범위는 Google Sheet에서 별도로 관리해야 합니다.
