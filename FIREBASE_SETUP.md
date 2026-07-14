# Firebase 무료 요금제 설정

## 1. 이메일/비밀번호 로그인 활성화

Firebase Console → Authentication → Sign-in method에서 **Email/Password**를 활성화합니다.

## 2. 최초 계정 생성

Authentication → Users → Add user에서 아래 계정을 만들고 초기 비밀번호는 모두 `123456`으로 입력합니다.

| 아이디 | Firebase 이메일 | 역할 |
|---|---|---|
| 강은석 | kw5232@naver.com | member |
| 박재현 | parkjh8372@naver.com | member |
| 강보선 | bosun1245@daum.net | member |
| 김류현 | kimwimi23@naver.com | member |
| 김준형 | 220041@naver.com | member |
| admin | yakolibre@gmail.com | admin |

처음 로그인하면 초기 비밀번호와 다른 6자리 이상의 비밀번호로 변경해야 합니다.

## 3. 사용자 프로필 생성

각 계정으로 `input.html`에 한 번씩 로그인하면 `users/{uid}` 문서가 자동 생성됩니다.

관리자 계정으로 한 번 로그인한 다음 Firestore Console에서 관리자 UID와 같은 `users/{uid}` 문서의 `role`을 `member`에서 `admin`으로 한 번 변경합니다. 이후 관리자 화면과 보안 규칙이 실제 관리자 권한을 확인합니다.

## 4. 보안 규칙 배포

Firebase CLI를 사용할 경우 프로젝트 폴더에서 다음을 실행합니다.

```bash
firebase login
firebase use smc-fm
firebase deploy --only firestore:rules
```

CLI를 사용하지 않으면 `firestore.rules` 내용을 Firebase Console → Firestore Database → Rules에 붙여넣고 게시합니다.

## 5. 비밀번호 재설정

- 로그인 화면에서 사용자가 본인 아이디를 선택하고 재설정 메일을 요청할 수 있습니다.
- 관리자 화면의 사용자 관리에서도 같은 재설정 메일을 발송할 수 있습니다.
- Spark 무료 요금제에서는 관리자가 타인의 비밀번호 값을 직접 정하지 않고, 실제 이메일 소유자가 링크를 열어 변경합니다.

## 6. 기존 업무 이전

- 관리자 → 사용자 관리 → 기존 업무 수신자 지정에서 수신자가 없는 업무를 정리합니다.
- 기존 업무를 처음 열면 기존 `history` 배열의 세부사항이 `requestTickets/{ticketId}/details` 하위 컬렉션으로 자동 복사됩니다.
- 사용자가 삭제한 관련업무는 실제 삭제되지 않고 관리자 → 자료보관으로 이동합니다.
