-- ============================================================================
-- 하원나라 데이터 이식 후 최종화 스크립트
-- ============================================================================
-- 실행 시점: 02_import_data.js 가 완료된 후
-- 실행 위치: Supabase Dashboard → SQL Editor
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. 시퀀스 재조정 (PostgreSQL의 SERIAL이 다음 ID부터 발급되도록)
-- ============================================================================
-- 이식한 데이터는 SQLite의 ID를 그대로 사용했으므로,
-- 새로 insert될 때 시퀀스가 충돌하지 않도록 MAX(id)+1로 재조정

SELECT setval(
    pg_get_serial_sequence('products', 'id'),
    COALESCE((SELECT MAX(id) FROM products), 1),
    true
);

SELECT setval(
    pg_get_serial_sequence('vouchers', 'id'),
    COALESCE((SELECT MAX(id) FROM vouchers), 1),
    true
);

SELECT setval(
    pg_get_serial_sequence('orders', 'id'),
    COALESCE((SELECT MAX(id) FROM orders), 1),
    true
);

SELECT setval(
    pg_get_serial_sequence('order_voucher_usages', 'id'),
    COALESCE((SELECT MAX(id) FROM order_voucher_usages), 1),
    true
);

SELECT setval(
    pg_get_serial_sequence('voucher_amounts', 'id'),
    COALESCE((SELECT MAX(id) FROM voucher_amounts), 1),
    true
);

-- ============================================================================
-- 2. 통계 확인
-- ============================================================================
SELECT '=== 이식 후 통계 ===' AS info;
SELECT * FROM admin_stats;

SELECT '=== 테이블별 행 수 ===' AS info;
SELECT
    'products' AS table_name, COUNT(*) AS row_count FROM products
UNION ALL SELECT 'vouchers', COUNT(*) FROM vouchers
UNION ALL SELECT 'orders', COUNT(*) FROM orders
UNION ALL SELECT 'order_voucher_usages', COUNT(*) FROM order_voucher_usages
UNION ALL SELECT 'voucher_amounts', COUNT(*) FROM voucher_amounts
ORDER BY table_name;

-- ============================================================================
-- 3. 시퀀스 현재값 확인
-- ============================================================================
SELECT '=== 시퀀스 다음 ID ===' AS info;
SELECT
    'products_id_seq' AS sequence_name,
    last_value AS current_value,
    last_value + 1 AS next_id
FROM products_id_seq
UNION ALL SELECT 'vouchers_id_seq', last_value, last_value + 1 FROM vouchers_id_seq
UNION ALL SELECT 'orders_id_seq', last_value, last_value + 1 FROM orders_id_seq
UNION ALL SELECT 'order_voucher_usages_id_seq', last_value, last_value + 1 FROM order_voucher_usages_id_seq
UNION ALL SELECT 'voucher_amounts_id_seq', last_value, last_value + 1 FROM voucher_amounts_id_seq;

-- ============================================================================
-- 4. 무결성 체크
-- ============================================================================
SELECT '=== 무결성 검증 ===' AS info;

-- 4-1. orders의 voucher_serial이 모두 vouchers에 존재하는가?
SELECT
    'orders → vouchers FK 검증' AS check_name,
    COUNT(*) AS orphan_count
FROM orders o
LEFT JOIN vouchers v ON o.voucher_serial = v.serial
WHERE v.serial IS NULL;

-- 4-2. orders의 product_id가 모두 products에 존재하는가?
SELECT
    'orders → products FK 검증' AS check_name,
    COUNT(*) AS orphan_count
FROM orders o
LEFT JOIN products p ON o.product_id = p.id
WHERE p.id IS NULL;

-- 4-3. order_voucher_usages의 order_id가 모두 orders에 존재하는가?
SELECT
    'usages → orders FK 검증' AS check_name,
    COUNT(*) AS orphan_count
FROM order_voucher_usages u
LEFT JOIN orders o ON u.order_id = o.id
WHERE o.id IS NULL;

-- 4-4. order_voucher_usages의 voucher_serial이 모두 vouchers에 존재하는가?
SELECT
    'usages → vouchers FK 검증' AS check_name,
    COUNT(*) AS orphan_count
FROM order_voucher_usages u
LEFT JOIN vouchers v ON u.voucher_serial = v.serial
WHERE v.serial IS NULL;

COMMIT;

-- ============================================================================
-- 모든 검증의 orphan_count = 0 이어야 정상입니다.
-- 만약 0이 아니면 외래키 위반이 있으므로 데이터 점검 필요
-- ============================================================================
