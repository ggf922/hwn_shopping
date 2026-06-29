-- ============================================================
-- 마이그레이션 09: 공급사 테이블 + products.supplier_id
-- 결산 대시보드 + 발주서 기능을 위해 필요
-- 
-- 실행: Supabase SQL Editor에 붙여넣고 RUN
-- 안전성: 모두 IF NOT EXISTS / ON CONFLICT 가드. 여러 번 실행 안전.
-- ============================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  format_type TEXT NOT NULL DEFAULT 'standard',
  contact TEXT,
  email TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO suppliers (name, format_type) VALUES 
  ('낭만찜찌개', 'nangman'),
  ('버니즈', 'standard'),
  ('모티스템', 'standard'),
  ('기타', 'standard')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);

-- 자동 매핑
WITH s AS (SELECT id, name FROM suppliers)
UPDATE products SET supplier_id = (SELECT id FROM s WHERE name = '낭만찜찌개')
WHERE supplier_id IS NULL
  AND (name ILIKE '%낭만%' OR name ILIKE '%김치찜개%' OR name ILIKE '%김치찜%');

WITH s AS (SELECT id, name FROM suppliers)
UPDATE products SET supplier_id = (SELECT id FROM s WHERE name = '버니즈')
WHERE supplier_id IS NULL
  AND (name ILIKE '%고구마%' OR name ILIKE '%블루베리%' OR name ILIKE '%옥수수%'
    OR name ILIKE '%부사%' OR name ILIKE '%사과즙%' OR name ILIKE '%키위%'
    OR name ILIKE '%복숭아%' OR name ILIKE '%감귤%' OR name ILIKE '%자두%'
    OR name ILIKE '%흑수박%' OR name ILIKE '%상주%곶감%');

WITH s AS (SELECT id, name FROM suppliers)
UPDATE products SET supplier_id = (SELECT id FROM s WHERE name = '모티스템')
WHERE supplier_id IS NULL
  AND (name ILIKE '%고시히카리%' OR name ILIKE '%여주쌀%' OR name ILIKE '%진상미%'
    OR name ILIKE '%해남 찰쌀%' OR name ILIKE '%해남 찰현미%' 
    OR name ILIKE '%해남 햇 찰보리쌀%' OR name ILIKE '%쌀%');

WITH s AS (SELECT id, name FROM suppliers)
UPDATE products SET supplier_id = (SELECT id FROM s WHERE name = '기타')
WHERE supplier_id IS NULL;

SELECT s.name AS supplier, s.format_type, COUNT(p.id) AS product_count
FROM suppliers s
LEFT JOIN products p ON p.supplier_id = s.id AND COALESCE(p.is_deleted, 0) = 0
GROUP BY s.id, s.name, s.format_type
ORDER BY product_count DESC;
