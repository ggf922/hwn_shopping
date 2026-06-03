/**
 * 하원나라 상품권 + 쇼핑몰 서버
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');
const { generateFullSerial, renderVoucherImage } = require('./voucher');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// 업로드 디렉터리 + multer 설정
// ─────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const safeName = `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/(jpeg|jpg|png|webp|gif)$/i;
    if (!allowed.test(file.mimetype)) {
      return cb(new Error('이미지 파일(jpg, png, webp, gif)만 업로드 가능합니다.'));
    }
    cb(null, true);
  }
});

// 미들웨어
app.use(express.json({ limit: '2mb' }));

// /admin 경로는 별도 라우트로 처리하므로 정적 서빙에서 제외 (보안)
app.use((req, res, next) => {
  if (req.path.startsWith('/admin')) return next();
  return express.static(path.join(__dirname, '..', 'public'))(req, res, next);
});

// 간단한 로깅
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────
// 인증 API
// ─────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
  }
  const token = auth.login(username, password);
  if (!token) {
    return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  res.json({ success: true, data: { token, username } });
});

app.post('/api/auth/logout', (req, res) => {
  const token = auth.extractToken(req);
  if (token) auth.logout(token);
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = auth.extractToken(req);
  const sess = token ? auth.verify(token) : null;
  if (!sess) {
    return res.status(401).json({ success: false, error: '인증 필요' });
  }
  res.json({ success: true, data: { username: sess.username } });
});

// ─────────────────────────────────────────────
// 이미지 업로드 API (관리자 전용)
// ─────────────────────────────────────────────
app.post('/api/upload', auth.requireAdmin, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: '파일이 없습니다.' });
    }
    const url = `/uploads/${req.file.filename}`;
    res.json({ success: true, data: { url, filename: req.file.filename, size: req.file.size } });
  });
});

// ─────────────────────────────────────────────
// 제품 (Products) CRUD API
// ─────────────────────────────────────────────

// 제품 목록 (삭제되지 않은 제품만)
app.get('/api/products', (req, res) => {
  try {
    // 관리자가 조회할 때는 ?include_deleted=1로 모두 조회 가능
    const includeDeleted = req.query.include_deleted === '1';
    const sql = includeDeleted
      ? 'SELECT * FROM products ORDER BY sort_order ASC, id ASC'
      : 'SELECT * FROM products WHERE COALESCE(is_deleted, 0) = 0 ORDER BY sort_order ASC, id ASC';
    const rows = db.prepare(sql).all();
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

// 제품 등록 (관리자)
app.post('/api/products', auth.requireAdmin, (req, res) => {
  try {
    const { name, price, description, image_url, stock } = req.body;
    if (!name || price == null) {
      return res.status(400).json({ success: false, error: '이름과 가격은 필수입니다.' });
    }
    // 신규 제품은 sort_order 최대값 + 1 (목록 맨 뒤에 추가)
    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM products').get();
    const nextOrder = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
    const result = db
      .prepare(
        'INSERT INTO products (name, price, description, image_url, stock, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(name, Number(price), description || '', image_url || '', Number(stock) || 0, nextOrder);
    const created = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: created });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 수정 (관리자)
app.put('/api/products/:id', auth.requireAdmin, (req, res) => {
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

// 제품 순서 변경 (관리자) - 단건 이동 (위/아래 한 칸)
// body: { direction: 'up' | 'down' }
app.post('/api/products/:id/move', auth.requireAdmin, (req, res) => {
  try {
    const productId = Number(req.params.id);
    const direction = req.body && req.body.direction;
    if (direction !== 'up' && direction !== 'down') {
      return res.status(400).json({ success: false, error: "direction은 'up' 또는 'down'이어야 합니다." });
    }

    const current = db.prepare('SELECT id, sort_order FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0').get(productId);
    if (!current) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });

    // 인접한 (위/아래) 활성 제품 찾기 — 정렬 순서 기준
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
    if (!neighbor) {
      return res.json({ success: true, moved: false, message: direction === 'up' ? '이미 최상단입니다.' : '이미 최하단입니다.' });
    }

    // 두 행의 sort_order 교환 (UNIQUE 제약이 없으므로 안전하게 스왑)
    const upd = db.prepare('UPDATE products SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const tx = db.transaction(() => {
      upd.run(neighbor.sort_order, current.id);
      upd.run(current.sort_order, neighbor.id);
    });
    tx();

    res.json({ success: true, moved: true, direction });
  } catch (e) {
    console.error('제품 순서 변경 오류:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 순서 일괄 변경 (관리자) - 전체 ID 배열을 받아 sort_order 재할당
// body: { ids: [id1, id2, ...] }  ← 화면에 보이는 순서대로
app.put('/api/products/reorder', auth.requireAdmin, (req, res) => {
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids 배열이 필요합니다.' });
    }
    const upd = db.prepare('UPDATE products SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const tx = db.transaction(() => {
      ids.forEach((id, idx) => upd.run(idx + 1, Number(id)));
    });
    tx();
    res.json({ success: true, count: ids.length });
  } catch (e) {
    console.error('제품 일괄 순서 변경 오류:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 제품 삭제 (관리자)
// - 주문 이력이 없으면 하드 삭제
// - 주문 이력이 있으면 소프트 삭제 (is_deleted = 1) — 주문 이력은 보존
app.delete('/api/products/:id', auth.requireAdmin, (req, res) => {
  try {
    const productId = req.params.id;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    if (!existing) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });

    const orderCount = db.prepare('SELECT COUNT(*) AS c FROM orders WHERE product_id = ?').get(productId).c;

    if (orderCount === 0) {
      // 주문 이력 없음 → 완전 삭제
      db.prepare('DELETE FROM products WHERE id = ?').run(productId);
      return res.json({ success: true, mode: 'hard', message: '제품이 삭제되었습니다.' });
    }

    // 주문 이력 있음 → 소프트 삭제 (목록에서는 숨김, 주문 이력은 그대로 유지)
    db.prepare('UPDATE products SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(productId);
    res.json({
      success: true,
      mode: 'soft',
      message: `주문 이력이 있어 목록에서 숨김 처리되었습니다. (관련 주문 ${orderCount}건 보존)`
    });
  } catch (e) {
    console.error('제품 삭제 오류:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// 상품권 (Vouchers) API
// ─────────────────────────────────────────────

// 발권 가능 금액
const VALID_AMOUNTS = [10000, 30000, 50000, 70000, 144000, 500000];

// 상품권 목록 (관리자)
app.get('/api/vouchers', auth.requireAdmin, (req, res) => {
  try {
    // ?include_deleted=1 인 경우 소프트 삭제된 상품권도 포함
    const includeDeleted = req.query.include_deleted === '1';
    const sql = includeDeleted
      ? 'SELECT * FROM vouchers ORDER BY issued_at DESC'
      : 'SELECT * FROM vouchers WHERE COALESCE(is_deleted, 0) = 0 ORDER BY issued_at DESC';
    const rows = db.prepare(sql).all();
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

// 상품권 발권 (관리자)
app.post('/api/vouchers', auth.requireAdmin, (req, res) => {
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
// - 주문 이력이 없으면 하드 삭제
// - 주문 이력이 있으면 소프트 삭제 (is_deleted = 1) — orders FK 충돌 방지 + 주문 이력 보존
// ※ 다중 상품권 결제 지원으로 인해 orders.voucher_serial 뿐 아니라
//   order_voucher_usages.voucher_serial 도 함께 확인해야 함
app.delete('/api/vouchers/:serial', auth.requireAdmin, (req, res) => {
  try {
    const serial = req.params.serial;
    const existing = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(serial);
    if (!existing) return res.status(404).json({ success: false, error: '상품권을 찾을 수 없습니다.' });

    // 1) orders.voucher_serial 에서의 참조 (primary serial)
    const primaryRefCount = db.prepare(
      'SELECT COUNT(*) AS c FROM orders WHERE voucher_serial = ?'
    ).get(serial).c;
    // 2) order_voucher_usages.voucher_serial 에서의 참조 (다중 결제 시 보조 사용)
    const usageRefCount = db.prepare(
      'SELECT COUNT(*) AS c FROM order_voucher_usages WHERE voucher_serial = ?'
    ).get(serial).c;
    const totalRefCount = primaryRefCount + usageRefCount;

    if (totalRefCount === 0) {
      // 어떤 주문에서도 사용되지 않음 → 완전 삭제
      db.prepare('DELETE FROM vouchers WHERE serial = ?').run(serial);
      return res.json({ success: true, mode: 'hard', message: '상품권이 삭제되었습니다.' });
    }

    // 주문 이력 있음 → 소프트 삭제 (목록에서는 숨김, 주문 이력은 그대로 유지)
    db.prepare('UPDATE vouchers SET is_deleted = 1 WHERE serial = ?').run(serial);
    // 영향받은 주문 수 (중복 제거)
    const distinctOrderCount = db.prepare(`
      SELECT COUNT(DISTINCT order_id) AS c FROM (
        SELECT id AS order_id FROM orders WHERE voucher_serial = ?
        UNION
        SELECT order_id FROM order_voucher_usages WHERE voucher_serial = ?
      )
    `).get(serial, serial).c;
    res.json({
      success: true,
      mode: 'soft',
      message: `주문 이력이 있어 목록에서 숨김 처리되었습니다. (관련 주문 ${distinctOrderCount}건 보존)`
    });
  } catch (e) {
    console.error('상품권 삭제 오류:', e);
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
    // 캐시 방지 — 렌더링 로직이 바뀌어도 즉시 반영되도록 함
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
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
// — 다중 상품권 결제 지원: voucher_serials[] (FIFO 순서로 차감)
// — 단일 상품권 결제 호환: voucher_serial (단일 문자열) 도 허용
app.post('/api/orders', (req, res) => {
  try {
    const {
      voucher_serials,           // 신규: 배열
      voucher_serial,            // 구버전 호환: 단일
      product_id,
      quantity = 1,
      recipient_name,
      recipient_phone,
      recipient_zipcode,
      recipient_address,
      recipient_address_detail,
      delivery_memo
    } = req.body;

    // 상품권 시리얼 목록 정리 (FIFO 순서 유지)
    let serials = [];
    if (Array.isArray(voucher_serials) && voucher_serials.length > 0) {
      serials = voucher_serials.map(s => String(s || '').trim().toUpperCase()).filter(Boolean);
    } else if (voucher_serial) {
      serials = [String(voucher_serial).trim().toUpperCase()];
    }

    if (serials.length === 0 || !product_id) {
      return res.status(400).json({ success: false, error: '상품권 번호와 제품을 선택해주세요.' });
    }

    // 중복 시리얼 차단 (한 주문에서 같은 상품권을 두 번 사용 불가)
    const dupCheck = new Set();
    for (const s of serials) {
      if (dupCheck.has(s)) {
        return res.status(400).json({ success: false, error: `같은 상품권이 중복으로 등록되어 있습니다: ${s}` });
      }
      dupCheck.add(s);
    }

    // 배송정보 필수 검증
    if (!recipient_name || !recipient_phone || !recipient_address) {
      return res.status(400).json({
        success: false,
        error: '받는 분 성함, 연락처, 주소는 필수 입력 항목입니다.'
      });
    }

    // 상품권 사전 검증 (모두 존재 + 사용 가능 + 잔액 합이 결제액 이상)
    const vouchers = [];
    for (const s of serials) {
      const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(s);
      if (!v) {
        return res.status(404).json({ success: false, error: `존재하지 않는 상품권입니다: ${s}` });
      }
      if (v.is_deleted) {
        return res.status(400).json({ success: false, error: `사용할 수 없는(삭제됨) 상품권입니다: ${s}` });
      }
      if (v.status !== 'active') {
        return res.status(400).json({ success: false, error: `이미 사용 완료된 상품권입니다: ${s}` });
      }
      if (v.balance <= 0) {
        return res.status(400).json({ success: false, error: `잔액이 없는 상품권입니다: ${s}` });
      }
      vouchers.push(v);
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) return res.status(404).json({ success: false, error: '존재하지 않는 제품입니다.' });
    if (product.is_deleted) {
      return res.status(400).json({ success: false, error: '판매가 중단된 제품입니다.' });
    }

    const qty = Math.max(Number(quantity) || 1, 1);
    if (product.stock < qty) {
      return res.status(400).json({ success: false, error: `재고가 부족합니다. (재고: ${product.stock})` });
    }

    const totalPrice = product.price * qty;
    const totalBalance = vouchers.reduce((sum, v) => sum + v.balance, 0);
    if (totalBalance < totalPrice) {
      return res.status(400).json({
        success: false,
        error: `상품권 잔액 합계가 부족합니다. (잔액 합계: ${totalBalance.toLocaleString()}원, 필요: ${totalPrice.toLocaleString()}원)`
      });
    }

    // 트랜잭션 — FIFO로 상품권 차감 + 주문 생성 + 사용 내역 기록
    const tx = db.transaction(() => {
      let remaining = totalPrice;
      const usages = []; // [{ serial, amount_used, sequence }]
      const nowIso = new Date().toISOString();

      for (let i = 0; i < vouchers.length && remaining > 0; i++) {
        const v = vouchers[i];
        const take = Math.min(remaining, v.balance);
        const newBalance = v.balance - take;
        const newStatus = newBalance === 0 ? 'used' : 'active';
        const usedAt = newBalance === 0 ? nowIso : v.used_at;

        db.prepare(
          'UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?'
        ).run(newBalance, newStatus, usedAt, v.serial);

        usages.push({ serial: v.serial, amount_used: take, sequence: i + 1 });
        remaining -= take;
      }

      // 재고 차감
      db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(qty, product_id);

      // 주문 행 생성 — orders.voucher_serial 에는 첫 번째 사용 상품권 보존 (구버전 호환)
      const primarySerial = usages[0].serial;
      const insertOrder = db.prepare(
        `INSERT INTO orders (
          voucher_serial, product_id, product_name, quantity, total_price,
          recipient_name, recipient_phone, recipient_zipcode,
          recipient_address, recipient_address_detail, delivery_memo
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const result = insertOrder.run(
        primarySerial, product_id, product.name, qty, totalPrice,
        recipient_name || '',
        recipient_phone || '',
        recipient_zipcode || '',
        recipient_address || '',
        recipient_address_detail || '',
        delivery_memo || ''
      );
      const orderId = result.lastInsertRowid;

      // 사용 내역 기록
      const insertUsage = db.prepare(
        'INSERT INTO order_voucher_usages (order_id, voucher_serial, amount_used, sequence) VALUES (?, ?, ?, ?)'
      );
      for (const u of usages) {
        insertUsage.run(orderId, u.serial, u.amount_used, u.sequence);
      }
      return orderId;
    });
    const orderId = tx();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const usages = db.prepare(
      'SELECT voucher_serial, amount_used, sequence FROM order_voucher_usages WHERE order_id = ? ORDER BY sequence ASC'
    ).all(orderId);
    const updatedVouchers = serials.map(s =>
      db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(s)
    );

    res.status(201).json({
      success: true,
      data: {
        order,
        usages,
        vouchers: updatedVouchers,
        // 구버전 호환 — 첫 상품권 정보
        voucher: updatedVouchers[0]
      }
    });
  } catch (e) {
    console.error('주문 생성 오류:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 주문 목록 (관리자) — 각 주문에 사용된 상품권 내역(usages) 포함
app.get('/api/orders', auth.requireAdmin, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
    const usageStmt = db.prepare(
      'SELECT voucher_serial, amount_used, sequence FROM order_voucher_usages WHERE order_id = ? ORDER BY sequence ASC'
    );
    for (const r of rows) {
      r.usages = usageStmt.all(r.id);
    }
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 주문 상태 변경 (관리자)
app.put('/api/orders/:id/status', auth.requireAdmin, (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'preparing', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: '유효하지 않은 상태입니다.' });
    }
    const result = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
    if (result.changes === 0) return res.status(404).json({ success: false, error: '주문을 찾을 수 없습니다.' });
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────
// 페이지 라우트
// ─────────────────────────────────────────────

// 관리자 로그인 페이지
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'login.html'));
});

// 관리자 메인 페이지: 인증 안 되어 있으면 로그인 페이지로 리다이렉트
app.get(['/admin', '/admin/'], (req, res) => {
  const token = auth.extractToken(req);
  if (!token || !auth.verify(token)) {
    return res.redirect('/admin/login');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎁 하원나라 서버 실행 중`);
  console.log(`   - 쇼핑몰:   http://localhost:${PORT}/`);
  console.log(`   - 관리자:   http://localhost:${PORT}/admin\n`);
});
