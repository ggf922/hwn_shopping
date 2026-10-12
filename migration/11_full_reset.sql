-- ============================================================================
-- 11_full_reset.sql
-- ============================================================================
-- 목적: 테스트 데이터 전체 초기화 + 발권 금액을 [3/5/10/20/30/50만]원으로 재설정
--
-- ⚠️ 매우 중요: 이 스크립트는 되돌릴 수 없는 삭제를 포함합니다!
--     실행 전에 반드시 아래 "삭제 대상"을 다시 확인하세요.
--
-- 실행 환경: Supabase SQL Editor
-- 실행 방법:
--   1. https://supabase.com/dashboard/project/efluojsyxoskhehbbjer/sql
--   2. 새 쿼리 창에 이 파일 전체 내용 붙여넣기
--   3. 아래 "최종 확인" 섹션의 BEGIN 주석을 풀기
--   4. "Run" 클릭
--
-- 삭제 대상:
--   - order_voucher_usages (상품권 사용 내역) 전체
--   - orders (주문 내역) 전체
--   - vouchers (발행된 상품권) 전체
--   - voucher_amounts (발권 금액 설정) 전체 → 신규 6개로 교체
--
-- 유지 대상:
--   - products (상품 카탈로그)
--   - suppliers (공급사)
--   - admin_settings (관리자 비밀번호) → 로그인 유지됨
--
-- 결산 대시보드: 별도 테이블 없이 orders/vouchers로부터 계산되므로
--   위 테이블들이 비워지면 자동으로 0 표시됨.
-- ============================================================================

-- ============================================================================
-- STEP 1: 삭제 전 현재 데이터 수량 확인 (안전장치)
-- ============================================================================
-- 이 SELECT만 먼저 실행해서 데이터 수량을 확인하세요.
SELECT
    (SELECT COUNT(*) FROM order_voucher_usages) AS "사용내역_건수",
    (SELECT COUNT(*) FROM orders)               AS "주문_건수",
    (SELECT COUNT(*) FROM vouchers)             AS "상품권_건수",
    (SELECT COUNT(*) FROM voucher_amounts WHERE is_active = 1) AS "활성_금액옵션_개수";

-- ============================================================================
-- STEP 2: 초기화 실행
-- ============================================================================
-- ⚠️ 위 SELECT 결과를 확인한 뒤에만 아래 BEGIN 주석을 풀고 실행하세요.
--    실행 후에는 되돌릴 수 없습니다.
--
-- 아래 전체 블록을 복사해서 그대로 실행하면 됩니다.
-- ============================================================================

BEGIN;

-- 2-1) 상품권 사용 내역 전체 삭제 (가장 먼저, FK 때문)
DELETE FROM order_voucher_usages;

-- 2-2) 주문 전체 삭제
DELETE FROM orders;

-- 2-3) 발행된 상품권 전체 삭제
DELETE FROM vouchers;

-- 2-4) 발권 금액 설정 전체 삭제
DELETE FROM voucher_amounts;

-- 2-5) 신규 발권 금액 6개 삽입: 3만/5만/10만/20만/30만/50만
INSERT INTO voucher_amounts (amount, sort_order, is_active)
VALUES
    ( 30000, 1, 1),
    ( 50000, 2, 1),
    (100000, 3, 1),
    (200000, 4, 1),
    (300000, 5, 1),
    (500000, 6, 1);

-- 2-6) 시퀀스 리셋 (ID가 1부터 다시 시작하도록, 선택사항)
--      PostgreSQL은 테이블의 BIGSERIAL ID 시퀀스를 별도 관리합니다.
--      새 데이터 ID가 1부터 깔끔하게 시작하길 원하면 아래 실행.
--      기존 삭제 데이터와 겹치지 않도록 ID만 리셋.
ALTER SEQUENCE IF EXISTS vouchers_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS orders_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS order_voucher_usages_id_seq RESTART WITH 1;
ALTER SEQUENCE IF EXISTS voucher_amounts_id_seq RESTART WITH 7;
-- voucher_amounts는 방금 1~6을 썼으므로 7부터 시작

-- 2-7) 최종 확인
SELECT
    (SELECT COUNT(*) FROM order_voucher_usages) AS "사용내역_건수",
    (SELECT COUNT(*) FROM orders)               AS "주문_건수",
    (SELECT COUNT(*) FROM vouchers)             AS "상품권_건수",
    (SELECT COUNT(*) FROM voucher_amounts WHERE is_active = 1) AS "활성_금액옵션_개수";
-- 기대 결과: 0, 0, 0, 6

-- 2-8) 신규 발권 금액 확인
SELECT amount, sort_order, is_active
  FROM voucher_amounts
 ORDER BY sort_order ASC;
-- 기대 결과: 30000, 50000, 100000, 200000, 300000, 500000 (6행)

COMMIT;
-- ⚠️ 문제가 있으면 COMMIT 대신 ROLLBACK; 을 실행하면 모든 변경이 취소됩니다.
--    단, 이미 COMMIT을 실행했다면 되돌릴 수 없습니다.
