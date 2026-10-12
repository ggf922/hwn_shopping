-- ============================================================================
-- 10_voucher_amounts_reset.sql
-- ============================================================================
-- 목적: 발권 가능 금액 목록을 [3만/5만/10만/20만/30만/50만]원 6개로 재설정
--
-- 실행 환경: Supabase SQL Editor
-- 실행 방법:
--   1. https://supabase.com/dashboard/project/efluojsyxoskhehbbjer/sql
--   2. 새 쿼리 창에 이 파일 전체 내용 붙여넣기
--   3. "Run" 클릭
--
-- 영향:
--   - voucher_amounts 테이블의 모든 기존 금액을 비활성화하고 새로 6개 삽입
--   - vouchers 테이블(이미 발행된 상품권)은 전혀 건드리지 않음
--     → 과거 발행된 상품권들(예: 70,000원짜리)은 그대로 유효, 그대로 사용 가능
--
-- 롤백:
--   아래 "복구 쿼리 예시" 섹션 참고
-- ============================================================================

BEGIN;

-- 1) 기존 모든 금액 비활성화 (soft disable, 데이터 보존)
--    is_active = 0 으로 두면 신규 발권 불가, 하지만 기록은 남음
UPDATE voucher_amounts
   SET is_active = 0
 WHERE is_active = 1;

-- 2) 신규 6개 금액을 ON CONFLICT로 upsert
--    - 이미 존재하는 금액(예: 30000, 50000, 100000, 200000, 300000, 500000)은
--      is_active = 1 로 다시 켜고 sort_order 재조정
--    - 신규 금액이면 삽입
INSERT INTO voucher_amounts (amount, sort_order, is_active)
VALUES
    ( 30000, 1, 1),
    ( 50000, 2, 1),
    (100000, 3, 1),
    (200000, 4, 1),
    (300000, 5, 1),
    (500000, 6, 1)
ON CONFLICT (amount) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    is_active  = 1;

-- 3) 결과 확인
SELECT id, amount, sort_order, is_active
  FROM voucher_amounts
 WHERE is_active = 1
 ORDER BY sort_order ASC;
-- 기대 결과: 6행 (30000, 50000, 100000, 200000, 300000, 500000)

COMMIT;

-- ============================================================================
-- 선택: 비활성화된 옛 금액을 완전히 삭제하려면 (돌이킬 수 없음)
-- ============================================================================
-- 아래 주석을 풀고 별도로 실행하세요. 지금은 안전을 위해 비활성화 상태로만 둠.
--
-- DELETE FROM voucher_amounts
--  WHERE is_active = 0
--    AND amount NOT IN (30000, 50000, 100000, 200000, 300000, 500000);

-- ============================================================================
-- 복구 쿼리 예시 (실수로 잘못 적용했을 때)
-- ============================================================================
-- 전체 되돌리기 (옛 금액 11개를 다시 활성화):
--
-- UPDATE voucher_amounts
--    SET is_active = 1,
--        sort_order = CASE amount
--            WHEN  10000 THEN 1
--            WHEN  30000 THEN 2
--            WHEN  50000 THEN 3
--            WHEN  70000 THEN 4
--            WHEN 100000 THEN 5
--            WHEN 140000 THEN 6
--            WHEN 144000 THEN 7
--            WHEN 200000 THEN 8
--            WHEN 300000 THEN 9
--            WHEN 500000 THEN 10
--            WHEN 1000000 THEN 11
--            ELSE sort_order
--        END
--  WHERE amount IN (10000, 30000, 50000, 70000, 100000, 140000, 144000,
--                   200000, 300000, 500000, 1000000);
