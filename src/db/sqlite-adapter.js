/**
 * ============================================================================
 * SQLite 어댑터 (better-sqlite3 기반)
 * ============================================================================
 * 기존 코드의 동작을 그대로 유지합니다. async 인터페이스를 노출하지만
 * 내부적으로는 동기 호출이며, async wrapper로 감싸서 일관성 유지.
 * ============================================================================
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'hawonnara.db'));
db.pragma('journal_mode = WAL');

// ─────────────────────────────────────────────
// 스키마 초기화 (기존 db.js에서 옮겨옴)
// ─────────────────────────────────────────────
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

  CREATE TABLE IF NOT EXISTS order_voucher_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    voucher_serial TEXT NOT NULL,
    amount_used INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (voucher_serial) REFERENCES vouchers(serial)
  );

  CREATE INDEX IF NOT EXISTS idx_order_voucher_usages_order_id ON order_voucher_usages(order_id);
  CREATE INDEX IF NOT EXISTS idx_order_voucher_usages_voucher_serial ON order_voucher_usages(voucher_serial);

  CREATE TABLE IF NOT EXISTS voucher_amounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER UNIQUE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// 발권 금액 시드
(() => {
    try {
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM voucher_amounts').get().c;
        if (cnt === 0) {
            const defaults = [10000, 30000, 50000, 70000, 100000, 140000, 144000, 200000, 300000, 500000, 1000000];
            const insert = db.prepare('INSERT INTO voucher_amounts (amount, sort_order, is_active) VALUES (?, ?, 1)');
            const tx = db.transaction(() => {
                defaults.forEach((amt, idx) => insert.run(amt, idx + 1));
            });
            tx();
            console.log(`[DB] 발권 금액 초기 시드 ${defaults.length}건 삽입`);
        }
    } catch (e) {
        console.error('[DB] voucher_amounts 초기 시드 실패:', e.message);
    }
})();

// 컬럼 마이그레이션
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
addColumnIfMissing('products', 'is_deleted', 'INTEGER DEFAULT 0');
addColumnIfMissing('vouchers', 'is_deleted', 'INTEGER DEFAULT 0');
addColumnIfMissing('products', 'sort_order', 'INTEGER');

(() => {
    const nullRows = db.prepare('SELECT id FROM products WHERE sort_order IS NULL ORDER BY id ASC').all();
    if (nullRows.length > 0) {
        const baseRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM products WHERE sort_order IS NOT NULL').get();
        let next = (baseRow && baseRow.m ? baseRow.m : 0) + 1;
        const upd = db.prepare('UPDATE products SET sort_order = ? WHERE id = ?');
        const tx = db.transaction(() => {
            for (const r of nullRows) {
                upd.run(next, r.id);
                next++;
            }
        });
        tx();
        console.log(`[DB] 마이그레이션: products.sort_order 초기값 ${nullRows.length}건 적용`);
    }
})();

(() => {
    try {
        const missingRows = db.prepare(`
            SELECT o.id, o.voucher_serial, o.total_price
            FROM orders o
            LEFT JOIN order_voucher_usages u ON u.order_id = o.id
            WHERE u.id IS NULL
        `).all();
        if (missingRows.length > 0) {
            const insert = db.prepare(
                'INSERT INTO order_voucher_usages (order_id, voucher_serial, amount_used, sequence) VALUES (?, ?, ?, ?)'
            );
            const tx = db.transaction(() => {
                for (const r of missingRows) {
                    insert.run(r.id, r.voucher_serial, r.total_price, 1);
                }
            });
            tx();
            console.log(`[DB] 마이그레이션: order_voucher_usages 백필 ${missingRows.length}건 적용`);
        }
    } catch (e) {
        console.error('[DB] order_voucher_usages 백필 실패:', e.message);
    }
})();

// ============================================================================
// products
// ============================================================================
const products = {
    async list({ includeDeleted = false } = {}) {
        const sql = includeDeleted
            ? 'SELECT * FROM products ORDER BY sort_order ASC, id ASC'
            : 'SELECT * FROM products WHERE COALESCE(is_deleted, 0) = 0 ORDER BY sort_order ASC, id ASC';
        return db.prepare(sql).all();
    },

    async get(id) {
        return db.prepare('SELECT * FROM products WHERE id = ?').get(id) || null;
    },

    async create({ name, price, description, image_url, stock }) {
        const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM products').get();
        const nextOrder = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
        const result = db.prepare(
            'INSERT INTO products (name, price, description, image_url, stock, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(name, Number(price), description || '', image_url || '', Number(stock) || 0, nextOrder);
        return db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    },

    async update(id, { name, price, description, image_url, stock }) {
        const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (!existing) return null;
        db.prepare(
            `UPDATE products SET
                name = ?, price = ?, description = ?, image_url = ?, stock = ?,
                updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`
        ).run(
            name ?? existing.name,
            price != null ? Number(price) : existing.price,
            description ?? existing.description,
            image_url ?? existing.image_url,
            stock != null ? Number(stock) : existing.stock,
            id
        );
        return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    },

    async remove(id) {
        const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
        if (!existing) return { notFound: true };

        const orderCount = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_id = ?').get(id).c;
        if (orderCount === 0) {
            db.prepare('DELETE FROM products WHERE id = ?').run(id);
            return { mode: 'hard' };
        }
        db.prepare('UPDATE products SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
        return { mode: 'soft', orderCount };
    },

    async move(id, direction) {
        const productId = Number(id);
        const current = db.prepare('SELECT id, sort_order FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(productId);
        if (!current) return { notFound: true };

        const neighborSql = direction === 'up'
            ? `SELECT id, sort_order FROM products
               WHERE COALESCE(is_deleted, 0) = 0
                 AND (sort_order < ? OR (sort_order = ? AND id < ?))
               ORDER BY sort_order DESC, id DESC LIMIT 1`
            : `SELECT id, sort_order FROM products
               WHERE COALESCE(is_deleted, 0) = 0
                 AND (sort_order > ? OR (sort_order = ? AND id > ?))
               ORDER BY sort_order ASC, id ASC LIMIT 1`;
        const neighbor = db.prepare(neighborSql).get(current.sort_order, current.sort_order, current.id);
        if (!neighbor) return { moved: false, atBoundary: true };

        const upd = db.prepare('UPDATE products SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const tx = db.transaction(() => {
            upd.run(neighbor.sort_order, current.id);
            upd.run(current.sort_order, neighbor.id);
        });
        tx();
        return { moved: true };
    },

    async reorder(ids) {
        const upd = db.prepare('UPDATE products SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        const tx = db.transaction(() => {
            ids.forEach((id, idx) => upd.run(idx + 1, Number(id)));
        });
        tx();
        return { count: ids.length };
    },
};

// ============================================================================
// vouchers
// ============================================================================
const vouchers = {
    async list({ includeDeleted = false } = {}) {
        const sql = includeDeleted
            ? 'SELECT * FROM vouchers ORDER BY issued_at DESC'
            : 'SELECT * FROM vouchers WHERE COALESCE(is_deleted, 0) = 0 ORDER BY issued_at DESC';
        return db.prepare(sql).all();
    },

    async get(serial) {
        return db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(serial) || null;
    },

    async create({ amount, quantity, generateSerial }) {
        const qty = Math.min(Math.max(Number(quantity) || 1, 1), 100);
        const insert = db.prepare('INSERT INTO vouchers (serial, amount, balance) VALUES (?, ?, ?)');
        const created = [];
        const tx = db.transaction(() => {
            for (let i = 0; i < qty; i++) {
                let serial;
                let attempts = 0;
                while (attempts < 10) {
                    serial = generateSerial();
                    const exists = db.prepare('SELECT 1 FROM vouchers WHERE serial = ?').get(serial);
                    if (!exists) break;
                    attempts++;
                }
                const result = insert.run(serial, Number(amount), Number(amount));
                created.push(db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid));
            }
        });
        tx();
        return created;
    },

    async remove(serial) {
        const existing = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(serial);
        if (!existing) return { notFound: true };

        const primaryRefCount = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE voucher_serial = ?').get(serial).c;
        const usageRefCount = db.prepare('SELECT COUNT(*) AS c FROM order_voucher_usages WHERE voucher_serial = ?').get(serial).c;
        const totalRefCount = primaryRefCount + usageRefCount;

        if (totalRefCount === 0) {
            db.prepare('DELETE FROM vouchers WHERE serial = ?').run(serial);
            return { mode: 'hard' };
        }

        db.prepare('UPDATE vouchers SET is_deleted = 1 WHERE serial = ?').run(serial);
        const distinctOrderCount = db.prepare(`
            SELECT COUNT(DISTINCT order_id) AS c FROM (
                SELECT id AS order_id FROM orders WHERE voucher_serial = ?
                UNION
                SELECT order_id FROM order_voucher_usages WHERE voucher_serial = ?
            )
        `).get(serial, serial).c;
        return { mode: 'soft', distinctOrderCount };
    },
};

// ============================================================================
// voucherAmounts
// ============================================================================
const voucherAmounts = {
    async list() {
        return db.prepare(
            'SELECT id, amount, sort_order, is_active FROM voucher_amounts WHERE is_active = 1 ORDER BY sort_order ASC, amount ASC'
        ).all();
    },

    async getValidAmounts() {
        return db.prepare(
            'SELECT amount FROM voucher_amounts WHERE is_active = 1 ORDER BY sort_order ASC, amount ASC'
        ).all().map(r => r.amount);
    },

    async create(amount) {
        const existing = db.prepare('SELECT id, is_active FROM voucher_amounts WHERE amount = ?').get(amount);
        if (existing) {
            if (existing.is_active === 1) {
                return { duplicate: true };
            }
            db.prepare('UPDATE voucher_amounts SET is_active = 1 WHERE id = ?').run(existing.id);
            return {
                row: db.prepare('SELECT id, amount, sort_order, is_active FROM voucher_amounts WHERE id = ?').get(existing.id)
            };
        }
        const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM voucher_amounts').get();
        const sortOrder = (maxRow.m || 0) + 1;
        const result = db.prepare(
            'INSERT INTO voucher_amounts (amount, sort_order, is_active) VALUES (?, ?, 1)'
        ).run(amount, sortOrder);
        return {
            row: db.prepare('SELECT id, amount, sort_order, is_active FROM voucher_amounts WHERE id = ?').get(result.lastInsertRowid)
        };
    },

    async remove(id) {
        const row = db.prepare('SELECT * FROM voucher_amounts WHERE id = ?').get(id);
        if (!row) return { notFound: true };

        const usedCount = db.prepare('SELECT COUNT(*) AS c FROM vouchers WHERE amount = ?').get(row.amount).c;
        if (usedCount > 0) {
            db.prepare('UPDATE voucher_amounts SET is_active = 0 WHERE id = ?').run(id);
            return { mode: 'soft', usedCount };
        }
        db.prepare('DELETE FROM voucher_amounts WHERE id = ?').run(id);
        return { mode: 'hard' };
    },
};

// ============================================================================
// orders
// ============================================================================
const orders = {
    async list() {
        const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
        const usageStmt = db.prepare(
            'SELECT voucher_serial, amount_used, sequence FROM order_voucher_usages WHERE order_id = ? ORDER BY sequence ASC'
        );
        for (const r of rows) {
            r.usages = usageStmt.all(r.id);
        }
        return rows;
    },

    async get(id) {
        const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (!row) return null;
        row.usages = db.prepare(
            'SELECT voucher_serial, amount_used, sequence FROM order_voucher_usages WHERE order_id = ? ORDER BY sequence ASC'
        ).all(id);
        return row;
    },

    /**
     * 주문 생성 (다중 상품권 결제, FIFO 차감)
     * @param {Object} opts
     * @param {string[]} opts.serials  - 시리얼 배열 (FIFO 순서)
     * @param {number} opts.product_id
     * @param {number} opts.quantity
     * @param {Object} opts.recipient  - 받는 분 정보
     */
    async create({ serials, product_id, quantity, recipient }) {
        // 사전 검증
        const vouchersToUse = [];
        for (const s of serials) {
            const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(s);
            if (!v) return { error: { code: 'VOUCHER_NOT_FOUND', serial: s } };
            if (v.is_deleted) return { error: { code: 'VOUCHER_DELETED', serial: s } };
            if (v.status !== 'active') return { error: { code: 'VOUCHER_USED', serial: s } };
            if (v.balance <= 0) return { error: { code: 'VOUCHER_NO_BALANCE', serial: s } };
            vouchersToUse.push(v);
        }

        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
        if (!product) return { error: { code: 'PRODUCT_NOT_FOUND' } };
        if (product.is_deleted) return { error: { code: 'PRODUCT_DELETED' } };

        const qty = Math.max(Number(quantity) || 1, 1);
        if (product.stock < qty) return { error: { code: 'OUT_OF_STOCK', stock: product.stock } };

        const totalPrice = product.price * qty;
        const totalBalance = vouchersToUse.reduce((sum, v) => sum + v.balance, 0);
        if (totalBalance < totalPrice) {
            return { error: { code: 'INSUFFICIENT_BALANCE', totalBalance, totalPrice } };
        }

        const tx = db.transaction(() => {
            let remaining = totalPrice;
            const usages = [];
            const nowIso = new Date().toISOString();

            for (let i = 0; i < vouchersToUse.length && remaining > 0; i++) {
                const v = vouchersToUse[i];
                const take = Math.min(remaining, v.balance);
                const newBalance = v.balance - take;
                const newStatus = newBalance === 0 ? 'used' : 'active';
                const usedAt = newBalance === 0 ? nowIso : v.used_at;

                db.prepare('UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?')
                    .run(newBalance, newStatus, usedAt, v.serial);

                usages.push({ serial: v.serial, amount_used: take, sequence: i + 1 });
                remaining -= take;
            }

            db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product_id);

            const primarySerial = usages[0].serial;
            const result = db.prepare(
                `INSERT INTO orders (
                    voucher_serial, product_id, product_name, quantity, total_price,
                    recipient_name, recipient_phone, recipient_zipcode,
                    recipient_address, recipient_address_detail, delivery_memo
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                primarySerial, product_id, product.name, qty, totalPrice,
                recipient.name || '', recipient.phone || '', recipient.zipcode || '',
                recipient.address || '', recipient.address_detail || '', recipient.memo || ''
            );
            const orderId = result.lastInsertRowid;

            const insertUsage = db.prepare(
                'INSERT INTO order_voucher_usages (order_id, voucher_serial, amount_used, sequence) VALUES (?, ?, ?, ?)'
            );
            for (const u of usages) {
                insertUsage.run(orderId, u.serial, u.amount_used, u.sequence);
            }
            return { orderId, usages };
        });
        const { orderId, usages } = tx();

        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        const updatedVouchers = serials.map(s =>
            db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(s)
        );

        return {
            order,
            usages,
            vouchers: updatedVouchers,
            voucher: updatedVouchers[0],
        };
    },

    async updateStatus(id, newStatus) {
        const orderId = Number(id);
        const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        if (!order) return { notFound: true };

        const prevStatus = order.status || 'pending';
        if (prevStatus === newStatus) {
            return { order, restored: false, noChange: true };
        }

        const usages = db.prepare(
            'SELECT voucher_serial, amount_used, sequence FROM order_voucher_usages WHERE order_id = ? ORDER BY sequence ASC'
        ).all(orderId);

        const effectiveUsages = usages.length > 0
            ? usages
            : [{ voucher_serial: order.voucher_serial, amount_used: order.total_price, sequence: 1 }];

        // CASE 1: 취소로 전환 → 복원
        if (prevStatus !== 'cancelled' && newStatus === 'cancelled') {
            const tx = db.transaction(() => {
                for (const u of effectiveUsages) {
                    const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial);
                    if (!v) continue;
                    const newBalance = v.balance + u.amount_used;
                    const vStatus = newBalance > 0 ? 'active' : v.status;
                    const newUsedAt = newBalance > 0 ? null : v.used_at;
                    db.prepare('UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?')
                        .run(newBalance, vStatus, newUsedAt, u.voucher_serial);
                }
                db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(order.quantity, order.product_id);
                db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, orderId);
            });
            tx();

            const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
            const restoredVouchers = effectiveUsages.map(u => ({
                serial: u.voucher_serial,
                amount_restored: u.amount_used,
                voucher: db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial)
            }));
            return { order: updated, restored: true, restored_vouchers: restoredVouchers, restored_stock: order.quantity };
        }

        // CASE 2: 취소 → 활성 (재차감)
        if (prevStatus === 'cancelled' && newStatus !== 'cancelled') {
            for (const u of effectiveUsages) {
                const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial);
                if (!v) return { error: { code: 'VOUCHER_NOT_FOUND', serial: u.voucher_serial } };
                if (v.balance < u.amount_used) {
                    return { error: { code: 'INSUFFICIENT_BALANCE_RESTORE', serial: u.voucher_serial, balance: v.balance, needed: u.amount_used } };
                }
            }
            const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
            if (!product || product.stock < order.quantity) {
                return { error: { code: 'OUT_OF_STOCK_RESTORE', needed: order.quantity, stock: product ? product.stock : 0 } };
            }

            const tx = db.transaction(() => {
                for (const u of effectiveUsages) {
                    const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial);
                    const newBalance = v.balance - u.amount_used;
                    const vStatus = newBalance === 0 ? 'used' : 'active';
                    const newUsedAt = newBalance === 0 ? new Date().toISOString() : v.used_at;
                    db.prepare('UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?')
                        .run(newBalance, vStatus, newUsedAt, u.voucher_serial);
                }
                db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(order.quantity, order.product_id);
                db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, orderId);
            });
            tx();

            const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
            return { order: updated, restored: false, rededucted: true };
        }

        // CASE 3: 단순 상태 변경
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, orderId);
        const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
        return { order: updated, restored: false };
    },
};

module.exports = {
    products,
    vouchers,
    voucherAmounts,
    orders,
    // 진단/유틸용 — Supabase 어댑터에는 없음
    _raw: db,
    _type: 'sqlite',
};
