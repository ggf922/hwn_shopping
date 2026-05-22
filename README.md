# 하원나라 (HAWONNARA) 🎁

프리미엄 상품권 발권 + 쇼핑몰 시스템

## 주요 기능

### 🛍️ 쇼핑몰 (사용자)
- 등록된 제품 목록 조회
- 상품권 번호로 잔액 확인
- 상품권으로 제품 구매 (잔액 차감)

### 🛠️ 관리자 페이지 (`/admin`)
- **상품권 발권**
  - 금액 선택 (1만/2만/5만/10만/30만/50만/100만 원)
  - 수량 지정 (최대 100장)
  - 일련번호 자동 생성: `HWN-YYYY-XX#####` (예: `HWN-2026-AF93875`)
  - 상품권 이미지 즉시 미리보기 및 **PNG 다운로드**
- **상품권 목록**: 발권된 모든 상품권 조회 / 이미지 다운로드 / 삭제
- **제품 관리 (CRUD)**: 제품 등록 / 수정 / 삭제 / 재고 관리
- **주문 내역**: 모든 결제 이력 조회

## 기술 스택
- 백엔드: Node.js + Express 4 + better-sqlite3
- 이미지: node-canvas (템플릿 위에 일련번호/금액 합성)
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
│  ├─ server.js      # Express 서버 (모든 API)
│  ├─ db.js          # SQLite 초기화 + 샘플 데이터
│  └─ voucher.js     # 일련번호 생성 + 이미지 렌더링
├─ public/
│  ├─ index.html     # 쇼핑몰 페이지
│  ├─ admin/index.html  # 관리자 페이지
│  ├─ css/style.css
│  ├─ js/shop.js     # 쇼핑몰 로직
│  ├─ js/admin.js    # 관리자 로직
│  └─ images/voucher-template.png  # 상품권 템플릿
├─ data/             # SQLite DB 파일 (자동 생성)
├─ package.json
└─ README.md
```

## API 엔드포인트

### 제품 (Products)
| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/products`        | 제품 목록 |
| GET    | `/api/products/:id`    | 제품 단건 |
| POST   | `/api/products`        | 제품 등록 |
| PUT    | `/api/products/:id`    | 제품 수정 |
| DELETE | `/api/products/:id`    | 제품 삭제 |

### 상품권 (Vouchers)
| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/vouchers`              | 발권 목록 |
| GET    | `/api/vouchers/:serial`      | 단건 조회 |
| POST   | `/api/vouchers`              | 발권 (`{amount, quantity}`) |
| DELETE | `/api/vouchers/:serial`      | 삭제 |
| GET    | `/api/vouchers/:serial/image[?download=1]` | 이미지(PNG) |

### 주문 (Orders)
| Method | Path | 설명 |
|--------|------|------|
| GET    | `/api/orders`                | 전체 주문 |
| POST   | `/api/orders`                | 구매 (`{voucher_serial, product_id, quantity}`) |

## 일련번호 규칙
`HWN-YYYY-XX#####`
- `HWN`: 하원나라 prefix
- `YYYY`: 발권 연도 (서버 기준)
- `XX`: 영문 대문자 2자리 (A-Z, 랜덤)
- `#####`: 숫자 5자리 (00000-99999, 랜덤)

예시: `HWN-2026-AF93875`, `HWN-2026-MN44767`
