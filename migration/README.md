# 하원나라 Supabase 마이그레이션 가이드

SQLite → Supabase (PostgreSQL) 데이터 이식 절차

---

## 📦 파일 구성

```
migration/
├── 01_schema.sql              ← Supabase에 먼저 실행 (테이블 생성)
├── 02_import_data.js          ← 데이터 이식 스크립트 (Node.js)
├── 03_finalize.sql            ← 이식 후 시퀀스/검증 실행
├── .env.migration.example     ← 환경변수 템플릿
├── .env.migration             ← 실제 환경변수 (git 제외)
└── README.md                  ← 이 문서
```

---

## 🚀 실행 절차 (순서대로!)

### Step 1: Supabase 프로젝트 생성 (사용자 작업)

1. https://supabase.com/dashboard 접속
2. [New project] 클릭
3. 설정:
   - **Name**: `hawonnara`
   - **Region**: **Northeast Asia (Seoul)** ⚠️ 필수
   - **Pricing Plan**: Pro (기존 결제 그대로 적용)
   - **Database Password**: 강력하게 생성 후 **반드시 별도 저장**
4. "Create new project" 클릭 → 1~2분 대기

### Step 2: API 키 확보 (사용자 작업)

Project Settings → API 에서 다음 3가지 복사:

| 항목 | 위치 | 용도 |
|------|------|------|
| Project URL | Project URL | 모든 통신 엔드포인트 |
| anon public | Project API keys | 클라이언트(브라우저) 공개 키 |
| service_role | Project API keys | 서버 비밀 키 (⚠️ 외부 공개 금지) |

### Step 3: 스키마 생성 (Supabase Dashboard 에서)

1. Supabase Dashboard → 좌측 **SQL Editor** 클릭
2. [+ New query] 클릭
3. `migration/01_schema.sql` 파일 내용 전체 복사 → 붙여넣기
4. 우측 하단 [Run] 클릭
5. 결과: "Success. No rows returned" 표시되면 OK
6. 검증: 좌측 **Table Editor** 에서 5개 테이블 확인
   - `products`, `vouchers`, `orders`, `order_voucher_usages`, `voucher_amounts`

### Step 4: 환경변수 설정 (Sandbox에서)

```bash
cd /home/user/webapp/migration
cp .env.migration.example .env.migration
nano .env.migration  # 또는 다른 편집기
```

내용:
```env
SUPABASE_URL=https://여기에서_복사한_URL.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc로_시작하는_긴_문자열
```

### Step 5: 의존성 설치

```bash
cd /home/user/webapp
npm install @supabase/supabase-js dotenv
```

### Step 6: DRY-RUN 테스트 (실제 입력 없이 검증만)

```bash
cd /home/user/webapp
node migration/02_import_data.js --dry-run
```

오류가 없어야 다음 단계로 진행.

### Step 7: 실제 데이터 이식

```bash
cd /home/user/webapp
node migration/02_import_data.js
```

진행 상황:
```
[INFO] products 이식 시작 (총 46행)
  [██████████████████████████████] 46/46 (100.0%)
[OK] products: 46 행 이식 완료

[INFO] vouchers 이식 시작 (총 2078행)
  [██████████████████████████████] 2078/2078 (100.0%)
[OK] vouchers: 2078 행 이식 완료

... (이하 동일)

[OK] 🎉 모든 데이터 이식 및 검증 완료!
```

### Step 8: 시퀀스 재조정 및 최종 검증

Supabase Dashboard → SQL Editor 에서:
1. `migration/03_finalize.sql` 전체 복사 → 붙여넣기 → Run
2. 결과 확인:
   - 시퀀스 재조정 완료
   - 테이블별 행 수가 원본과 일치
   - 모든 FK 검증의 `orphan_count` = 0

---

## ✅ 이식 완료 후 확인 체크리스트

- [ ] products: 46 행
- [ ] vouchers: 2,078 행
- [ ] orders: 635 행
- [ ] order_voucher_usages: 1,038 행
- [ ] voucher_amounts: 11 행
- [ ] **합계: 3,808 행 일치**
- [ ] 모든 FK 검증의 orphan_count = 0
- [ ] 시퀀스 다음 ID가 적절히 설정됨

---

## 🚨 문제 발생 시 롤백

### 데이터만 삭제 (스키마 유지)

Supabase SQL Editor 에서:
```sql
TRUNCATE TABLE order_voucher_usages, orders, vouchers, products, voucher_amounts
RESTART IDENTITY CASCADE;
```

### 완전히 처음부터 다시 (스키마까지)

```sql
DROP TABLE IF EXISTS order_voucher_usages CASCADE;
DROP TABLE IF EXISTS orders CASCADE;
DROP TABLE IF EXISTS vouchers CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS voucher_amounts CASCADE;
DROP VIEW IF EXISTS admin_stats;
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
```

그 후 `01_schema.sql` 부터 다시 실행.

---

## 🔒 보안 주의사항

- ❌ **service_role 키는 절대 코드에 하드코딩하지 말 것**
- ❌ **`.env.migration` 파일을 절대 git commit하지 말 것** (.gitignore에 등록됨)
- ✅ Vercel 배포 시 환경변수는 Vercel Dashboard에서 설정
- ✅ 브라우저(클라이언트) 코드에는 anon key만 사용

---

## 📊 데이터 정합성 보장

- 이식 중 sandbox의 SQLite는 **계속 운영 가능** (읽기 전용 백업에서 이식하므로)
- 이식 완료 후 sandbox에서 발생한 신규 데이터는 별도 동기화 필요
- 권장: 이식 시점부터 sandbox는 "참조용"으로만 운영, 신규 입력은 Supabase로
