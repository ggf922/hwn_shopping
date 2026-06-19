-- ============================================================================
-- 하원나라 (HAWONNARA) PostgreSQL 스키마
-- SQLite → PostgreSQL (Supabase) 변환 버전
-- 생성일: 2026-06-19
-- 대상: Supabase Pro (Northeast Asia / Seoul)
-- ============================================================================

-- 안전을 위해 트랜잭션으로 감싸기
BEGIN;

-- ============================================================================
-- 1. PRODUCTS 테이블 (상품)
-- ============================================================================
CREATE TABLE IF NOT EXISTS products (
    id              BIGSERIAL PRIMARY KEY,
    name            TEXT NOT NULL,
    price           BIGINT NOT NULL CHECK (price >= 0),
    description     TEXT,
    image_url       TEXT,
    stock           INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    is_deleted      SMALLINT NOT NULL DEFAULT 0,
    sort_order      INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_is_deleted ON products(is_deleted);
CREATE INDEX IF NOT EXISTS idx_products_sort_order ON products(sort_order);

COMMENT ON TABLE products IS '판매 상품 목록';
COMMENT ON COLUMN products.is_deleted IS '소프트 삭제 플래그 (0:정상, 1:삭제)';

-- ============================================================================
-- 2. VOUCHERS 테이블 (상품권)
-- ============================================================================
CREATE TABLE IF NOT EXISTS vouchers (
    id              BIGSERIAL PRIMARY KEY,
    serial          TEXT UNIQUE NOT NULL,
    amount          BIGINT NOT NULL CHECK (amount >= 0),
    balance         BIGINT NOT NULL CHECK (balance >= 0),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'used', 'cancelled', 'expired')),
    is_deleted      SMALLINT NOT NULL DEFAULT 0,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vouchers_serial ON vouchers(serial);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_is_deleted ON vouchers(is_deleted);

COMMENT ON TABLE vouchers IS '발권된 상품권';
COMMENT ON COLUMN vouchers.serial IS '시리얼 번호 (HWN-2026-XXXXXX 형식)';
COMMENT ON COLUMN vouchers.balance IS '잔액 (부분 사용 후 남은 금액)';

-- ============================================================================
-- 3. ORDERS 테이블 (주문)
-- ============================================================================
CREATE TABLE IF NOT EXISTS orders (
    id                          BIGSERIAL PRIMARY KEY,
    voucher_serial              TEXT NOT NULL,
    product_id                  BIGINT NOT NULL,
    product_name                TEXT NOT NULL,
    quantity                    INTEGER NOT NULL CHECK (quantity > 0),
    total_price                 BIGINT NOT NULL CHECK (total_price >= 0),
    recipient_name              TEXT,
    recipient_phone             TEXT,
    recipient_zipcode           TEXT,
    recipient_address           TEXT,
    recipient_address_detail    TEXT,
    delivery_memo               TEXT,
    status                      TEXT NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_orders_voucher FOREIGN KEY (voucher_serial)
        REFERENCES vouchers(serial) ON DELETE RESTRICT,
    CONSTRAINT fk_orders_product FOREIGN KEY (product_id)
        REFERENCES products(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_orders_voucher_serial ON orders(voucher_serial);
CREATE INDEX IF NOT EXISTS idx_orders_product_id ON orders(product_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

COMMENT ON TABLE orders IS '주문 내역';

-- ============================================================================
-- 4. ORDER_VOUCHER_USAGES 테이블 (주문별 상품권 사용 내역)
-- ============================================================================
CREATE TABLE IF NOT EXISTS order_voucher_usages (
    id              BIGSERIAL PRIMARY KEY,
    order_id        BIGINT NOT NULL,
    voucher_serial  TEXT NOT NULL,
    amount_used     BIGINT NOT NULL CHECK (amount_used >= 0),
    sequence        INTEGER NOT NULL CHECK (sequence > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_usages_order FOREIGN KEY (order_id)
        REFERENCES orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_usages_voucher FOREIGN KEY (voucher_serial)
        REFERENCES vouchers(serial) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_usages_order_id ON order_voucher_usages(order_id);
CREATE INDEX IF NOT EXISTS idx_usages_voucher_serial ON order_voucher_usages(voucher_serial);

COMMENT ON TABLE order_voucher_usages IS '주문별 상품권 사용 내역 (한 주문에 여러 장 사용 가능)';

-- ============================================================================
-- 5. VOUCHER_AMOUNTS 테이블 (발권 가능 금액 목록)
-- ============================================================================
CREATE TABLE IF NOT EXISTS voucher_amounts (
    id              BIGSERIAL PRIMARY KEY,
    amount          BIGINT UNIQUE NOT NULL CHECK (amount > 0),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    is_active       SMALLINT NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voucher_amounts_active ON voucher_amounts(is_active, sort_order);

COMMENT ON TABLE voucher_amounts IS '관리자가 설정한 발권 가능 금액 목록';

-- ============================================================================
-- 6. UPDATED_AT 자동 갱신 트리거 (products 테이블용)
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_products_updated_at ON products;
CREATE TRIGGER trigger_products_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 7. ROW LEVEL SECURITY (RLS) - Supabase 권장
-- ============================================================================
-- 일단 모든 테이블 RLS 활성화 (정책은 별도로 추가)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_voucher_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE voucher_amounts ENABLE ROW LEVEL SECURITY;

-- 기본 정책: service_role은 모든 작업 가능 (서버 측에서만 사용)
-- anon/authenticated 정책은 02_policies.sql 에서 별도 관리

-- service_role 우회 정책 (서버에서 service_role key로 접근 시 RLS 우회)
-- ※ service_role은 자동으로 RLS를 우회하므로 별도 정책 불필요

-- ============================================================================
-- 8. 통계 확인 뷰 (관리용)
-- ============================================================================
CREATE OR REPLACE VIEW admin_stats AS
SELECT
    (SELECT COUNT(*) FROM products WHERE is_deleted = 0) AS active_products,
    (SELECT COUNT(*) FROM vouchers WHERE status = 'active') AS active_vouchers,
    (SELECT COUNT(*) FROM orders) AS total_orders,
    (SELECT COALESCE(SUM(total_price), 0) FROM orders WHERE status != 'cancelled') AS total_revenue,
    (SELECT COUNT(*) FROM voucher_amounts WHERE is_active = 1) AS active_amount_options;

COMMIT;

-- ============================================================================
-- 검증 쿼리 (스키마 생성 후 실행)
-- ============================================================================
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
-- SELECT * FROM admin_stats;
