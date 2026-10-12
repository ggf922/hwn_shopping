# kwells.shop 도메인 연결 가이드

> **대상**: K-웰스몰 사이트에 `kwells.shop` 도메인 연결 (기존 `hwnara.shop` 교체)
> **배포 플랫폼**: Vercel
> **도메인 등록 업체**: 가비아 (Gabia)

---

## 📋 전체 흐름 (총 소요시간: 30분 ~ 24시간)

```
① 가비아에서 kwells.shop 구매 (5~10분, 결제 포함)
     ↓
② Vercel에 kwells.shop 추가 (2분)
     ↓
③ Vercel이 알려주는 DNS 값을 가비아에 설정 (5분)
     ↓
④ DNS 전파 대기 (10분 ~ 24시간, 보통 1시간 이내)
     ↓
⑤ Vercel에서 자동 SSL 인증서 발급 확인 (자동, 수 분)
     ↓
⑥ hwnara.shop → kwells.shop 리다이렉트 설정 (선택)
     ↓
완료 ✅
```

---

## ① 가비아에서 kwells.shop 구매

1. **https://domain.gabia.com** 접속
2. 검색창에 `kwells.shop` 입력 → 검색
3. 사용 가능하면 **"구매하기"** → **"바로구매"** 선택
4. 결제 완료 (`.shop` 도메인은 보통 연 **5~15만원 수준**)
5. 구매 후 **"My가비아 → 도메인 관리"** 메뉴에서 보유 도메인 확인

> 💡 **중요**: 구매 시 **"네임서버 설정"** 질문이 나오면 **"가비아 기본 네임서버"**로 두세요. 그래야 가비아 DNS 관리 화면에서 레코드 편집이 가능합니다.

---

## ② Vercel에 kwells.shop 도메인 추가

1. **https://vercel.com/dashboard** 접속 → `hwnara` 프로젝트 선택
2. 상단 메뉴 **"Settings"** → 좌측 **"Domains"** 클릭
3. 입력창에 `kwells.shop` 입력 → **"Add"** 클릭
4. 다시 입력창에 `www.kwells.shop` 입력 → **"Add"** 클릭

> 💡 보통 `kwells.shop`과 `www.kwells.shop` **둘 다 추가**합니다.

5. Vercel이 바로 **아래와 같은 DNS 설정 안내 화면**을 보여줍니다:

### 📍 Vercel이 요구하는 DNS 레코드

| 호스트 | 타입 | 값 | 용도 |
|---|---|---|---|
| `@` (루트) | **A** | `76.76.21.21` | kwells.shop 접속 |
| `www` | **CNAME** | `cname.vercel-dns.com` | www.kwells.shop 접속 |

> ⚠️ Vercel이 **실제로 보여주는 값을 그대로 사용**하세요. 위 값은 2026년 기준 Vercel 공식 안내 기본값이지만, 간혹 다른 IP나 다른 CNAME을 안내할 수 있습니다. 반드시 **Vercel 화면에 뜨는 값**을 복사하세요.

---

## ③ 가비아에서 DNS 레코드 설정

> ⏱️ **이 부분이 가장 중요합니다. 정확히 아래 순서대로 하세요.**

### 3-1. 가비아 DNS 설정 화면 진입
1. **My가비아 로그인**: https://my.gabia.com/
2. 상단 **"서비스 관리"** → **"도메인 통합관리툴"**
3. **"kwells.shop"** 왼쪽 체크박스 체크 → 상단 **"DNS 관리"** 버튼 클릭
4. **"DNS 설정"** 화면 진입

### 3-2. 기존 레코드 정리 (중요)
가비아는 기본적으로 "가비아 웹호스팅 서비스 안내 페이지"가 떠있을 수 있는 A 레코드가 있을 수 있습니다. 다음 레코드가 있으면 **삭제**하거나 수정합니다:
- 호스트 `@`로 설정된 다른 A 레코드
- 호스트 `www`로 설정된 다른 CNAME 레코드

### 3-3. A 레코드 추가 (루트 도메인 → Vercel)
**"레코드 추가"** 버튼 클릭 후:

| 항목 | 값 |
|---|---|
| 타입 | **A** |
| 호스트 | **@** (또는 비워둠 — 가비아 UI에 따라 다름) |
| 값/위치 | **76.76.21.21** (Vercel이 안내하는 IP) |
| TTL | **600** (10분) |

→ **"저장"** 클릭

### 3-4. CNAME 레코드 추가 (www → Vercel)
**"레코드 추가"** 클릭 후:

| 항목 | 값 |
|---|---|
| 타입 | **CNAME** |
| 호스트 | **www** |
| 값/위치 | **cname.vercel-dns.com.** (끝에 점 포함, 가비아는 자동으로 처리하므로 점 없이 입력해도 됨) |
| TTL | **600** |

→ **"저장"** 클릭

### 3-5. 저장 적용
설정 화면 하단 **"저장"** 또는 **"설정 적용"** 버튼을 반드시 클릭해야 실제 반영됩니다.

---

## ④ DNS 전파 대기

- 보통 **5분 ~ 1시간** 안에 반영됨
- 길면 최대 24~48시간 (가비아는 보통 빠름)
- 아래 명령으로 확인 가능:

```bash
# 터미널 (Mac/Linux) 또는 PowerShell
nslookup kwells.shop
# 결과에 "76.76.21.21"이 나오면 성공

nslookup www.kwells.shop
# 결과에 "cname.vercel-dns.com" 또는 Vercel IP가 나오면 성공
```

또는 **온라인 DNS 체커**:
- https://www.whatsmydns.net/#A/kwells.shop
- 전 세계 여러 지역에서 전파 상태 확인 가능

---

## ⑤ Vercel 자동 SSL 인증서 발급

DNS가 전파되는 즉시 Vercel이 자동으로:
1. **Let's Encrypt SSL 인증서 발급** (무료, 자동 갱신)
2. **HTTPS 활성화**

Vercel 대시보드 → Settings → Domains 에서 도메인 옆에 **녹색 체크 ✓** 뜨면 완료.

> 🚨 **만약 "Invalid Configuration" 오류**가 뜬다면:
> - 가비아 DNS 설정이 아직 전파 안 됨 → 1~2시간 더 대기
> - 또는 가비아 DNS 값이 잘못됨 → ③ 다시 확인

---

## ⑥ hwnara.shop → kwells.shop 리다이렉트 설정 (선택)

### 방법 A: Vercel에서 리다이렉트 (가장 간단, 추천)

1. Vercel → Settings → Domains
2. **hwnara.shop** 옆 **"..."** 메뉴 → **"Redirect to..."**
3. **kwells.shop** 선택 → **"Save"**
4. 영구 리다이렉트(308) 자동 적용됨

이제 누군가 `https://www.hwnara.shop/` 접속하면 자동으로 `https://www.kwells.shop/`으로 넘어갑니다.

### 방법 B: 코드로 리다이렉트 (더 세밀한 제어)
`vercel.json`에 아래 추가:
```json
"redirects": [
  {
    "source": "/(.*)",
    "has": [{ "type": "host", "value": "hwnara.shop" }],
    "destination": "https://www.kwells.shop/$1",
    "permanent": true
  },
  {
    "source": "/(.*)",
    "has": [{ "type": "host", "value": "www.hwnara.shop" }],
    "destination": "https://www.kwells.shop/$1",
    "permanent": true
  }
]
```

> 💡 저(에이전트)에게 "코드로 리다이렉트 적용해줘"라고 하시면 즉시 PR 올려드립니다.

---

## 🛠 트러블슈팅

### "Verifying configuration..." 상태에서 안 넘어감
- DNS 전파가 안 끝났을 가능성. 1시간 더 기다리세요.
- `nslookup`으로 가비아 설정이 반영됐는지 확인하세요.

### "This domain is already assigned to another project"
- 다른 Vercel 프로젝트가 kwells.shop을 선점 중. 그 프로젝트에서 먼저 제거 필요.

### kwells.shop은 접속 되는데 www.kwells.shop은 안 됨
- 가비아에서 `www` CNAME 레코드 안 넣었거나 잘못 넣음
- ③-4 다시 확인

### "ERR_SSL_PROTOCOL_ERROR"
- DNS는 됐지만 SSL 발급 중. 5~10분 더 대기.
- 1시간 넘어도 안 되면 Vercel 지원 요청.

---

## 📞 지원 요청 템플릿

문제가 생기면 저에게 다음 정보와 함께 알려주세요:
```
1. 가비아 kwells.shop DNS 설정 스크린샷
2. Vercel Domains 화면 스크린샷
3. nslookup kwells.shop 결과
4. 접속 시 보이는 에러 메시지
```

---

## ✅ 완료 체크리스트

- [ ] 가비아에서 kwells.shop 구매 완료
- [ ] Vercel에 kwells.shop + www.kwells.shop 추가
- [ ] 가비아에 A 레코드 (@, 76.76.21.21) 추가
- [ ] 가비아에 CNAME 레코드 (www, cname.vercel-dns.com) 추가
- [ ] `nslookup kwells.shop` 성공
- [ ] Vercel 대시보드에서 녹색 체크 확인
- [ ] 브라우저에서 https://kwells.shop 접속 성공
- [ ] 브라우저에서 https://www.kwells.shop 접속 성공
- [ ] (선택) hwnara.shop → kwells.shop 리다이렉트 설정

모든 체크 완료되면 K-웰스몰은 공식적으로 kwells.shop에서 운영됩니다! 🎉
