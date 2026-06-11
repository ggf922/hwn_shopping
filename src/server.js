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

// 발권 가능 금액 (DB의 voucher_amounts 테이블에서 동적 조회)
function getValidAmounts() {
  return db.prepare(
    'SELECT amount FROM voucher_amounts WHERE is_active = 1 ORDER BY sort_order ASC, amount ASC'
  ).all().map(r => r.amount);
}

// ─────────────────────────────────────────────
// 발권 금액 관리 API
// ─────────────────────────────────────────────

// 발권 금액 목록 조회 (공개 — 쇼핑몰/관리자 페이지 모두 사용)
app.get('/api/voucher-amounts', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, amount, sort_order, is_active FROM voucher_amounts WHERE is_active = 1 ORDER BY sort_order ASC, amount ASC'
    ).all();
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 발권 금액 추가 (관리자)
app.post('/api/voucher-amounts', auth.requireAdmin, (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < 1000 || amount > 100000000) {
      return res.status(400).json({
        success: false,
        error: '금액은 1,000원 이상 1억원 이하의 정수여야 합니다.'
      });
    }
    // 중복 체크 (활성/비활성 무관 — UNIQUE 제약)
    const existing = db.prepare('SELECT id, is_active FROM voucher_amounts WHERE amount = ?').get(amount);
    if (existing) {
      if (existing.is_active === 1) {
        return res.status(400).json({ success: false, error: '이미 등록된 금액입니다.' });
      }
      // 비활성 → 다시 활성화
      db.prepare('UPDATE voucher_amounts SET is_active = 1 WHERE id = ?').run(existing.id);
      const row = db.prepare('SELECT id, amount, sort_order, is_active FROM voucher_amounts WHERE id = ?').get(existing.id);
      return res.status(201).json({ success: true, data: row });
    }
    // 새 sort_order = 현재 최대값 + 1
    const maxRow = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM voucher_amounts').get();
    const sortOrder = (maxRow.m || 0) + 1;
    const result = db.prepare(
      'INSERT INTO voucher_amounts (amount, sort_order, is_active) VALUES (?, ?, 1)'
    ).run(amount, sortOrder);
    const row = db.prepare('SELECT id, amount, sort_order, is_active FROM voucher_amounts WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: row });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 발권 금액 삭제 (관리자)
// — 이미 발권된 상품권이 있는 금액은 비활성화(soft) 처리, 없으면 하드 삭제
app.delete('/api/voucher-amounts/:id', auth.requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM voucher_amounts WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ success: false, error: '해당 금액을 찾을 수 없습니다.' });

    const usedCount = db.prepare('SELECT COUNT(*) AS c FROM vouchers WHERE amount = ?').get(row.amount).c;
    if (usedCount > 0) {
      // 발권 이력 존재 → 비활성화만 (이력 보존)
      db.prepare('UPDATE voucher_amounts SET is_active = 0 WHERE id = ?').run(id);
      return res.json({
        success: true,
        mode: 'soft',
        message: `해당 금액으로 발권된 상품권이 ${usedCount}장 존재하여 비활성화되었습니다. (목록에서는 숨김 처리)`
      });
    }
    db.prepare('DELETE FROM voucher_amounts WHERE id = ?').run(id);
    res.json({ success: true, mode: 'hard', message: '금액이 삭제되었습니다.' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

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
    const validAmounts = getValidAmounts();
    if (!validAmounts.includes(Number(amount))) {
      return res.status(400).json({
        success: false,
        error: `발권 가능 금액: ${validAmounts.map(a => a.toLocaleString() + '원').join(', ')}`
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
// — 'cancelled' 로 전환 시: 사용된 상품권 잔액 복원 + 제품 재고 복원
// — 'cancelled' → 다른 상태로 재전환 시: 다시 차감 + 재고 차감
//   (단, 잔액이 부족하거나 재고가 부족하면 거부)
app.put('/api/orders/:id/status', auth.requireAdmin, (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['pending', 'preparing', 'shipped', 'delivered', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, error: '유효하지 않은 상태입니다.' });
    }

    const orderId = Number(req.params.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return res.status(404).json({ success: false, error: '주문을 찾을 수 없습니다.' });

    const prevStatus = order.status || 'pending';
    if (prevStatus === status) {
      // 동일 상태로의 변경은 잔액·재고를 건드리지 않음
      return res.json({ success: true, data: order, restored: false });
    }

    const usages = db.prepare(
      'SELECT voucher_serial, amount_used, sequence FROM order_voucher_usages WHERE order_id = ? ORDER BY sequence ASC'
    ).all(orderId);

    // 백워드 호환: order_voucher_usages 가 비어있는 옛 주문은
    // orders.voucher_serial 한 장으로 total_price 전액 결제된 것으로 간주
    const effectiveUsages = usages.length > 0
      ? usages
      : [{ voucher_serial: order.voucher_serial, amount_used: order.total_price, sequence: 1 }];

    // ── CASE 1: 취소로 전환 (active → cancelled) — 잔액·재고 복원 ──
    if (prevStatus !== 'cancelled' && status === 'cancelled') {
      const tx = db.transaction(() => {
        for (const u of effectiveUsages) {
          const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial);
          if (!v) continue; // 상품권이 (소프트 삭제 외) 어떤 이유로 사라진 경우는 건너뜀
          const newBalance = v.balance + u.amount_used;
          // 잔액이 0보다 커지면 다시 사용 가능 상태로 복귀
          const newStatus = newBalance > 0 ? 'active' : v.status;
          // used_at 은 잔액이 양수로 돌아오면 초기화
          const newUsedAt = newBalance > 0 ? null : v.used_at;
          db.prepare(
            'UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?'
          ).run(newBalance, newStatus, newUsedAt, u.voucher_serial);
        }
        // 제품 재고 복원 (제품이 소프트 삭제되었더라도 stock 환원은 수행)
        db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(order.quantity, order.product_id);
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
      });
      tx();

      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      const restoredVouchers = effectiveUsages.map(u => ({
        serial: u.voucher_serial,
        amount_restored: u.amount_used,
        voucher: db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial)
      }));
      return res.json({
        success: true,
        data: updated,
        restored: true,
        restored_vouchers: restoredVouchers,
        restored_stock: order.quantity
      });
    }

    // ── CASE 2: 취소 상태에서 다시 활성 상태로 전환 — 재차감 ──
    if (prevStatus === 'cancelled' && status !== 'cancelled') {
      // 사전 검증: 모든 상품권이 차감 가능한지 확인 (현재 잔액 + 다른 주문의 사용분 무관)
      for (const u of effectiveUsages) {
        const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial);
        if (!v) {
          return res.status(400).json({
            success: false,
            error: `복원 불가: 상품권을 찾을 수 없습니다 (${u.voucher_serial}).`
          });
        }
        if (v.balance < u.amount_used) {
          return res.status(400).json({
            success: false,
            error: `복원 불가: 상품권 ${u.voucher_serial} 잔액(${v.balance.toLocaleString()}원)이 부족하여 ${u.amount_used.toLocaleString()}원을 다시 차감할 수 없습니다.`
          });
        }
      }
      // 사전 검증: 재고
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
      if (!product || product.stock < order.quantity) {
        return res.status(400).json({
          success: false,
          error: `복원 불가: 제품 재고가 부족합니다. (필요 ${order.quantity}개, 현재 ${product ? product.stock : 0}개)`
        });
      }

      const tx = db.transaction(() => {
        for (const u of effectiveUsages) {
          const v = db.prepare('SELECT * FROM vouchers WHERE serial = ?').get(u.voucher_serial);
          const newBalance = v.balance - u.amount_used;
          const newStatus = newBalance === 0 ? 'used' : 'active';
          const newUsedAt = newBalance === 0 ? new Date().toISOString() : v.used_at;
          db.prepare(
            'UPDATE vouchers SET balance = ?, status = ?, used_at = ? WHERE serial = ?'
          ).run(newBalance, newStatus, newUsedAt, u.voucher_serial);
        }
        db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?').run(order.quantity, order.product_id);
        db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
      });
      tx();

      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      return res.json({ success: true, data: updated, restored: false, rededucted: true });
    }

    // ── CASE 3: 그 외 — 단순 상태 변경 (active 상태들 사이의 전환) ──
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    res.json({ success: true, data: updated, restored: false });
  } catch (e) {
    console.error('주문 상태 변경 오류:', e);
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
