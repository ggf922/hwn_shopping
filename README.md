# 하원나라 (HAWONNARA) 🎁

프리미엄 상품권 발권 + 쇼핑몰 + 배송 관리 시스템

## 🔐 관리자 로그인

| 항목 | 값 |
|------|------|
| URL  | `/admin/login` (또는 `/admin` 접속 시 자동 리다이렉트) |
| 아이디 | `admin` |
| 비밀번호 | `admin123` |
| 세션 유효 시간 | 8시간 |

> ⚠️ 운영 환경에서는 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 환경변수로 변경 가능합니다.
> ```bash
> ADMIN_USERNAME=myadmin ADMIN_PASSWORD='S3cret!' npm start
> ```

## 주요 기능

### 🛍️ 쇼핑몰 (사용자)
- 등록된 제품 목록 조회
- 상품권 번호로 잔액 확인
- 상품권으로 제품 구매 (잔액 차감)
- **배송 정보 입력**: 받는 분 / 연락처 / 우편번호 / 주소 / 상세주소 / 배송메모

### 🛠️ 관리자 페이지 (`/admin`)
- **상품권 발권**
  - 금액 선택 (1만/2만/5만/10만/30만/50만/100만 원)
  - 수량 지정 (최대 100장)
  - 일련번호 자동 생성: `HWN-YYYY-XX#####` (예: `HWN-2026-AF93875`)
  - 상품권 이미지 즉시 미리보기 및 **PNG 다운로드**
- **상품권 목록**: 발권된 모든 상품권 조회 / 이미지 다운로드 / 삭제
- **제품 관리 (CRUD)**: 제품 등록 / 수정 / 삭제 / 재고 관리
  - **이미지 파일 직접 업로드** (jpg, png, webp, gif, 최대 5MB)
  - 또는 외부 이미지 URL 입력
  - 실시간 미리보기
- **주문 내역**: 모든 결제 이력 + 배송정보 조회
  - 받는 분, 연락처, 주소, 배송 메모 표시
  - 주문 상태 변경 (결제완료 → 배송준비 → 배송중 → 배송완료/취소)

## 📏 제품 이미지 권장 규격

| 항목 | 권장값 |
|------|--------|
| **크기** | **800 × 800 px** (정사각형, 1:1 비율) |
| **최소** | 600 × 600 px 이상 |
| **최대 파일 크기** | 5 MB |
| **포맷** | JPG, PNG, WEBP, GIF |

> 정사각형 1:1 비율을 권장하는 이유는 쇼핑몰 카드 디자인이 정사각형 썸네일을 기준으로 디자인되어 있고, 모바일/PC 어느 화면에서도 일관되게 보이기 때문입니다. 다른 비율의 이미지도 업로드 가능하지만, 화면에서 잘리거나 여백이 생길 수 있습니다.

## 기술 스택
- 백엔드: Node.js + Express 4 + better-sqlite3 + multer
- 이미지: node-canvas (상품권 합성), multer (제품 이미지 업로드)
- 프론트엔드: Vanilla HTML/CSS/JS (의존성 없음)
- DB: SQLite (`data/hawonnara.db`)

## 실행 방법
```bash
npm install
npm start
# → http://localhost:3000/        (쇼핑몰)
# → http://localhost:3000/admin   (관리자)
```

## 디렉터리 구조
```
webapp/
├─ src/
│  ├─ server.js      # Express 서버 (모든 API + 이미지 업로드 + 인증)
│  ├─ db.js          # SQLite 초기화 + 자동 마이그레이션
│  ├─ voucher.js     # 일련번호 생성 + 이미지 렌더링
│  └─ auth.js        # 관리자 토큰 기반 인증
├─ public/
│  ├─ index.html               # 쇼핑몰 페이지
│  ├─ admin/login.html         # 관리자 로그인 페이지
│  ├─ admin/index.html         # 관리자 대시보드 (인증 필요)
│  ├─ css/style.css
│  ├─ js/shop.js               # 쇼핑몰 로직 (배송정보 폼 포함)
│  ├─ js/admin.js              # 관리자 로직 (인증, 이미지 업로드, 주문 관리)
│  ├─ uploads/                 # 업로드된 제품 이미지 저장소
│  └─ images/voucher-template.png  # 상품권 템플릿
├─ data/             # SQLite DB 파일 (자동 생성)
├─ package.json
└─ README.md
```

## API 엔드포인트

> 🔒 표시된 API는 `Authorization: Bearer <token>` 헤더가 필요한 관리자 전용 API입니다.

### 인증
| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/auth/login` | `{username, password}` → token 발급 |
| POST | `/api/auth/logout` | 로그아웃 (토큰 무효화) |
| GET  | `/api/auth/me` | 현재 세션 정보 |

### 업로드 🔒
| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/upload` | 제품 이미지 업로드 (multipart, field name: `image`) |

### 제품 (Products)
| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/products`        | 제품 목록 |
| GET    | `/api/products/:id`    | 제품 단건 |
| POST   | `/api/products`        🔒 | 제품 등록 |
| PUT    | `/api/products/:id`    🔒 | 제품 수정 |
| DELETE | `/api/products/:id`    🔒 | 제품 삭제 |

### 상품권 (Vouchers)
| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/vouchers`              🔒 | 발권 목록 |
| GET    | `/api/vouchers/:serial`      | 단건 조회 (구매 시 잔액 확인용) |
| POST   | `/api/vouchers`              🔒 | 발권 (`{amount, quantity}`) |
| DELETE | `/api/vouchers/:serial`      🔒 | 삭제 |
| GET    | `/api/vouchers/:serial/image[?download=1]` | 이미지(PNG) |

### 주문 (Orders)
| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/orders`                🔒 | 전체 주문 (배송정보 포함) |
| POST   | `/api/orders`                | 구매 (배송정보 필수) |
| PUT    | `/api/orders/:id/status`     🔒 | 주문 상태 변경 |

#### 구매 요청 페이로드 예시
```json
{
  "voucher_serial": "HWN-2026-AF93875",
  "product_id": 1,
  "quantity": 1,
  "recipient_name": "홍길동",
  "recipient_phone": "010-1234-5678",
  "recipient_zipcode": "03187",
  "recipient_address": "서울특별시 종로구 종로 1",
  "recipient_address_detail": "101동 1004호",
  "delivery_memo": "부재 시 경비실에 맡겨 주세요"
}
```

## 일련번호 규칙
`HWN-YYYY-XX#####`
- `HWN`: 하원나라 prefix
- `YYYY`: 발권 연도
- `XX`: 영문 대문자 2자리 (랜덤)
- `#####`: 숫자 5자리 (랜덤)

예시: `HWN-2026-AF93875`, `HWN-2026-MN44767`

## 주문 상태
- `pending` (결제완료) — 기본값
- `preparing` (배송준비)
- `shipped` (배송중)
- `delivered` (배송완료)
- `cancelled` (취소)
