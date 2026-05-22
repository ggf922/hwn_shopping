/**
 * SQLite 데이터베이스 초기화 및 연결 모듈
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hawonnara.db'));
db.pragma('journal_mode = WAL');

// 테이블 생성
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price INTEGER NOT NULL,
    description TEXT,
    image_url TEXT,
    stock INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    used_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_serial TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_price INTEGER NOT NULL,
    recipient_name TEXT,
    recipient_phone TEXT,
    recipient_zipcode TEXT,
    recipient_address TEXT,
    recipient_address_detail TEXT,
    delivery_memo TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (voucher_serial) REFERENCES vouchers(serial),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );
`);

// 마이그레이션: 기존 orders 테이블에 배송정보 컬럼이 없으면 추가
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[DB] 마이그레이션: ${table}.${column} 추가`);
  }
}
addColumnIfMissing('orders', 'recipient_name', 'TEXT');
addColumnIfMissing('orders', 'recipient_phone', 'TEXT');
addColumnIfMissing('orders', 'recipient_zipcode', 'TEXT');
addColumnIfMissing('orders', 'recipient_address', 'TEXT');
addColumnIfMissing('orders', 'recipient_address_detail', 'TEXT');
addColumnIfMissing('orders', 'delivery_memo', 'TEXT');
addColumnIfMissing('orders', 'status', "TEXT DEFAULT 'pending'");
// products 소프트 삭제 컬럼 (주문 이력 보존을 위해 FK 충돌 시 사용)
addColumnIfMissing('products', 'is_deleted', 'INTEGER DEFAULT 0');

// 초기 샘플 데이터 (제품이 없을 때만)
const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (productCount === 0) {
  const insert = db.prepare(
    'INSERT INTO products (name, price, description, image_url, stock) VALUES (?, ?, ?, ?, ?)'
  );
  const samples = [
    ['하원나라 프리미엄 한과세트', 35000, '전통 한과를 정성껏 담은 선물세트입니다.', 'https://images.unsplash.com/photo-1601001435957-74f0958a93c5?w=600', 50],
    ['하원나라 명품 홍삼정', 120000, '6년근 홍삼으로 만든 프리미엄 홍삼정.', 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=600', 30],
    ['하원나라 유기농 차 세트', 45000, '엄선된 유기농 차 3종 세트.', 'https://images.unsplash.com/photo-1597481499750-3e6b22637e12?w=600', 100],
    ['하원나라 견과 선물세트', 28000, '신선한 견과류 5종 모음.', 'https://images.unsplash.com/photo-1599599810694-57a2ca8276a8?w=600', 80]
  ];
  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  insertMany(samples);
  console.log('[DB] 샘플 제품 데이터 삽입 완료');
}

module.exports = db;
