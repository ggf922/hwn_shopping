/**
 * 하원나라 상품권 + 쇼핑몰 서버
 */
const express = require('express');
const path = require('path');
const db = require('./db');
const { generateFullSerial, renderVoucherImage } = require('./voucher');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 간단한 로깅
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────
// 제품 (Products) CRUD API
// ─────────────────────────────────────────────

// 제품 목록
app.get('/api/products', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 단건
app.get('/api/products/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });
    res.json({ success: true, data: row });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 등록
app.post('/api/products', (req, res) => {
  try {
    const { name, price, description, image_url, stock } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ success: false, error: '이름과 가격은 필수입니다.' });
    }
    const result = db
      .prepare(
        'INSERT INTO products (name, price, description, image_url, stock) VALUES (?, ?, ?, ?, ?)'
      )
      .run(name, Number(price), description || '', image_url || '', Number(stock) || 0);
    const created = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: created });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 수정
app.put('/api/products/:id', (req, res) => {
  try {
    const { name, price, description, image_url, stock } = req.body;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });

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
      req.params.id
    );
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 삭제
app.delete('/api/products/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// 상품권 (Vouchers) API
// ─────────────────────────────────────────────

// 발권 가능 금액
const VALID_AMOUNTS = [10000, 20000, 50000, 100000, 300000, 500000, 1000000];

// 상품권 목록
app.get('/api/vouchers', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM vouchers ORDER BY issued_at DESC').all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 상품권 단건 조회 (시리얼 번호로)
app.get('/api/vouchers/:serial', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(req.params.serial);
    if (!row) return res.status(404).json({ success: false, error: '상품권을 찾을 수 없습니다.' });
    res.json({ success: true, data: row });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 상품권 발권
app.post('/api/vouchers', (req, res) => {
  try {
    const { amount, quantity = 1 } = req.body;
    if (!VALID_AMOUNTS.includes(Number(amount))) {
      return res.status(400).json({
        success: false,
        error: `발권 가능 금액: ${VALID_AMOUNTS.map(a => a.toLocaleString() + '원').join(', ')}`
      });
    }
    const qty = Math.min(Math.max(Number(quantity) || 1, 1), 100);

    const insert = db.prepare(
      'INSERT INTO vouchers (serial, amount, balance) VALUES (?, ?, ?)'
    );
    const created = [];
    const tx = db.transaction(() => {
      for (let i = 0; i < qty; i++) {
        let serial;
        let attempts = 0;
        // 중복 방지
        while (attempts < 10) {
          serial = generateFullSerial();
          const exists = db.prepare('SELECT 1 FROM vouchers WHERE serial = ?').get(serial);
          if (!exists) break;
          attempts++;
        }
        const result = insert.run(serial, Number(amount), Number(amount));
        created.push(db.prepare('SELECT * FROM vouchers WHERE id = ?').get(result.lastInsertRowid));
      }
    });
    tx();
    res.status(201).json({ success: true, data: created });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 상품권 삭제 (관리자)
app.delete('/api/vouchers/:serial', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM vouchers WHERE serial = ?').run(req.params.serial);
    if (result.changes === 0) return res.status(404).json({ success: false, error: '상품권을 찾을 수 없습니다.' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 상품권 이미지 다운로드
app.get('/api/vouchers/:serial/image', async (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(req.params.serial);
    if (!row) return res.status(404).send('상품권을 찾을 수 없습니다.');

    const buffer = await renderVoucherImage({ serial: row.serial, amount: row.amount });
    res.setHeader('Content-Type', 'image/png');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${row.serial}.png"`);
    }
    res.send(buffer);
  } catch (e) {
    console.error('이미지 생성 오류:', e);
    res.status(500).send('이미지 생성 실패: ' + e.message);
  }
});

// ─────────────────────────────────────────────
// 주문 (Orders) API - 상품권으로 결제
// ─────────────────────────────────────────────

// 구매 처리
app.post('/api/orders', (req, res) => {
  try {
    const { voucher_serial, product_id, quantity = 1 } = req.body;
    if (!voucher_serial || !product_id) {
      return res.status(400).json({ success: false, error: '상품권 번호와 제품을 선택해주세요.' });
    }

    const voucher = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(voucher_serial);
    if (!voucher) return res.status(404).json({ success: false, error: '존재하지 않는 상품권입니다.' });
    if (voucher.status !== 'active') {
      return res.status(400).json({ success: false, error: '사용할 수 없는 상품권입니다.' });
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) return res.status(404).json({ success: false, error: '존재하지 않는 제품입니다.' });

    const qty = Math.max(Number(quantity) || 1, 1);
    if (product.stock < qty) {
      return res.status(400).json({ success: false, error: `재고가 부족합니다. (재고: ${product.stock})` });
    }

    const totalPrice = product.price * qty;
    if (voucher.balance < totalPrice) {
      return res.status(400).json({
        success: false,
        error: `상품권 잔액이 부족합니다. (잔액: ${voucher.balance.toLocaleString()}원, 필요: ${totalPrice.toLocaleString()}원)`
      });
    }

    // 트랜잭션
    const tx = db.transaction(() => {
      const newBalance = voucher.balance - totalPrice;
      const newStatus = newBalance === 0 ? 'used' : 'active';
      const usedAt = newBalance === 0 ? new Date().toISOString() : null;

      db.prepare(
        'UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?'
      ).run(newBalance, newStatus, usedAt, voucher_serial);

      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product_id);

      const result = db
        .prepare(
          'INSERT INTO orders (voucher_serial, product_id, product_name, quantity, total_price) VALUES (?, ?, ?, ?, ?)'
        )
        .run(voucher_serial, product_id, product.name, qty, totalPrice);
      return result.lastInsertRowid;
    });
    const orderId = tx();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const updatedVoucher = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(voucher_serial);
    res.status(201).json({ success: true, data: { order, voucher: updatedVoucher } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 주문 목록
app.get('/api/orders', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// 라우트
// ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎁 하원나라 서버 실행 중`);
  console.log(`   - 쇼핑몰:   http://localhost:${PORT}/`);
  console.log(`   - 관리자:   http://localhost:${PORT}/admin\n`);
});
