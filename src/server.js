/**
 * 하원나라 상품권 + 쇼핑몰 서버 (어댑터 패턴 적용)
 *
 * 환경변수:
 *   USE_SUPABASE=true → Supabase 모드 (Vercel/Production)
 *   미설정 또는 false → SQLite 모드 (로컬/sandbox)
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
  limits: { fileSize: 5 * 1024 * 1024 },
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

// 공통 오류 처리 헬퍼 (async 라우트 catch)
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

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
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: '파일이 없습니다.' });
    const url = `/uploads/${req.file.filename}`;
    res.json({ success: true, data: { url, filename: req.file.filename, size: req.file.size } });
  });
});

// ─────────────────────────────────────────────
// 제품 (Products) CRUD API
// ─────────────────────────────────────────────

// 제품 목록
app.get('/api/products', ah(async (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const rows = await db.products.list({ includeDeleted });
  res.json({ success: true, data: rows });
}));

// 제품 단건
app.get('/api/products/:id', ah(async (req, res) => {
  const row = await db.products.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });
  res.json({ success: true, data: row });
}));

// 제품 등록 (관리자)
app.post('/api/products', auth.requireAdmin, ah(async (req, res) => {
  const { name, price, description, image_url, stock } = req.body;
  if (!name || price == null) {
    return res.status(400).json({ success: false, error: '이름과 가격은 필수입니다.' });
  }
  const created = await db.products.create({ name, price, description, image_url, stock });
  res.status(201).json({ success: true, data: created });
}));

// 제품 수정 (관리자)
app.put('/api/products/:id', auth.requireAdmin, ah(async (req, res) => {
  const updated = await db.products.update(req.params.id, req.body);
  if (!updated) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });
  res.json({ success: true, data: updated });
}));

// 제품 순서 일괄 변경 (관리자)
// — 라우트 순서: /reorder 가 /:id/move 보다 먼저 등장하도록 배치하는 것이 중요!
app.put('/api/products/reorder', auth.requireAdmin, ah(async (req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ success: false, error: 'ids 배열이 필요합니다.' });
  }
  const result = await db.products.reorder(ids);
  res.json({ success: true, count: result.count });
}));

// 제품 순서 단건 이동 (관리자)
app.post('/api/products/:id/move', auth.requireAdmin, ah(async (req, res) => {
  const direction = req.body && req.body.direction;
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ success: false, error: "direction은 'up' 또는 'down'이어야 합니다." });
  }
  const result = await db.products.move(req.params.id, direction);
  if (result.notFound) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });
  if (result.atBoundary) {
    return res.json({ success: true, moved: false, message: direction === 'up' ? '이미 최상단입니다.' : '이미 최하단입니다.' });
  }
  res.json({ success: true, moved: true, direction });
}));

// 제품 삭제 (관리자)
app.delete('/api/products/:id', auth.requireAdmin, ah(async (req, res) => {
  const result = await db.products.remove(req.params.id);
  if (result.notFound) return res.status(404).json({ success: false, error: '제품을 찾을 수 없습니다.' });
  if (result.mode === 'hard') {
    return res.json({ success: true, mode: 'hard', message: '제품이 삭제되었습니다.' });
  }
  res.json({
    success: true,
    mode: 'soft',
    message: `주문 이력이 있어 목록에서 숨김 처리되었습니다. (관련 주문 ${result.orderCount}건 보존)`
  });
}));

// ─────────────────────────────────────────────
// 발권 금액 관리 API
// ─────────────────────────────────────────────

app.get('/api/voucher-amounts', ah(async (req, res) => {
  const rows = await db.voucherAmounts.list();
  res.json({ success: true, data: rows });
}));

app.post('/api/voucher-amounts', auth.requireAdmin, ah(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 1000 || amount > 100000000) {
    return res.status(400).json({
      success: false,
      error: '금액은 1,000원 이상 1억원 이하의 정수여야 합니다.'
    });
  }
  const result = await db.voucherAmounts.create(amount);
  if (result.duplicate) return res.status(400).json({ success: false, error: '이미 등록된 금액입니다.' });
  res.status(201).json({ success: true, data: result.row });
}));

app.delete('/api/voucher-amounts/:id', auth.requireAdmin, ah(async (req, res) => {
  const result = await db.voucherAmounts.remove(Number(req.params.id));
  if (result.notFound) return res.status(404).json({ success: false, error: '해당 금액을 찾을 수 없습니다.' });
  if (result.mode === 'soft') {
    return res.json({
      success: true,
      mode: 'soft',
      message: `해당 금액으로 발권된 상품권이 ${result.usedCount}장 존재하여 비활성화되었습니다. (목록에서는 숨김 처리)`
    });
  }
  res.json({ success: true, mode: 'hard', message: '금액이 삭제되었습니다.' });
}));

// ─────────────────────────────────────────────
// 상품권 (Vouchers) API
// ─────────────────────────────────────────────

// 상품권 목록 (관리자)
app.get('/api/vouchers', auth.requireAdmin, ah(async (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const rows = await db.vouchers.list({ includeDeleted });
  res.json({ success: true, data: rows });
}));

// 상품권 단건 조회 (시리얼)
app.get('/api/vouchers/:serial', ah(async (req, res) => {
  const row = await db.vouchers.get(req.params.serial);
  if (!row) return res.status(404).json({ success: false, error: '상품권을 찾을 수 없습니다.' });
  res.json({ success: true, data: row });
}));

// 상품권 발권 (관리자)
app.post('/api/vouchers', auth.requireAdmin, ah(async (req, res) => {
  const { amount, quantity = 1 } = req.body;
  const validAmounts = await db.voucherAmounts.getValidAmounts();
  if (!validAmounts.includes(Number(amount))) {
    return res.status(400).json({
      success: false,
      error: `발권 가능 금액: ${validAmounts.map(a => a.toLocaleString() + '원').join(', ')}`
    });
  }
  const created = await db.vouchers.create({
    amount: Number(amount),
    quantity,
    generateSerial: generateFullSerial,
  });
  res.status(201).json({ success: true, data: created });
}));

// 상품권 삭제 (관리자)
app.delete('/api/vouchers/:serial', auth.requireAdmin, ah(async (req, res) => {
  const result = await db.vouchers.remove(req.params.serial);
  if (result.notFound) return res.status(404).json({ success: false, error: '상품권을 찾을 수 없습니다.' });
  if (result.mode === 'hard') {
    return res.json({ success: true, mode: 'hard', message: '상품권이 삭제되었습니다.' });
  }
  res.json({
    success: true,
    mode: 'soft',
    message: `주문 이력이 있어 목록에서 숨김 처리되었습니다. (관련 주문 ${result.distinctOrderCount}건 보존)`
  });
}));

// 상품권 이미지 다운로드
app.get('/api/vouchers/:serial/image', ah(async (req, res) => {
  const row = await db.vouchers.get(req.params.serial);
  if (!row) return res.status(404).send('상품권을 찾을 수 없습니다.');
  try {
    const buffer = await renderVoucherImage({ serial: row.serial, amount: row.amount });
    res.setHeader('Content-Type', 'image/png');
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
}));

// ─────────────────────────────────────────────
// 주문 (Orders) API
// ─────────────────────────────────────────────

// 구매 처리
app.post('/api/orders', ah(async (req, res) => {
  const {
    voucher_serials, voucher_serial, product_id, quantity = 1,
    recipient_name, recipient_phone, recipient_zipcode,
    recipient_address, recipient_address_detail, delivery_memo
  } = req.body;

  let serials = [];
  if (Array.isArray(voucher_serials) && voucher_serials.length > 0) {
    serials = voucher_serials.map(s => String(s || '').trim().toUpperCase()).filter(Boolean);
  } else if (voucher_serial) {
    serials = [String(voucher_serial).trim().toUpperCase()];
  }

  if (serials.length === 0 || !product_id) {
    return res.status(400).json({ success: false, error: '상품권 번호와 제품을 선택해주세요.' });
  }

  // 중복 시리얼 차단
  const dupCheck = new Set();
  for (const s of serials) {
    if (dupCheck.has(s)) {
      return res.status(400).json({ success: false, error: `같은 상품권이 중복으로 등록되어 있습니다: ${s}` });
    }
    dupCheck.add(s);
  }

  if (!recipient_name || !recipient_phone || !recipient_address) {
    return res.status(400).json({
      success: false,
      error: '받는 분 성함, 연락처, 주소는 필수 입력 항목입니다.'
    });
  }

  const result = await db.orders.create({
    serials,
    product_id,
    quantity,
    recipient: {
      name: recipient_name,
      phone: recipient_phone,
      zipcode: recipient_zipcode,
      address: recipient_address,
      address_detail: recipient_address_detail,
      memo: delivery_memo,
    },
  });

  if (result.error) {
    const err = result.error;
    const messages = {
      VOUCHER_NOT_FOUND: `존재하지 않는 상품권입니다: ${err.serial}`,
      VOUCHER_DELETED: `사용할 수 없는(삭제됨) 상품권입니다: ${err.serial}`,
      VOUCHER_USED: `이미 사용 완료된 상품권입니다: ${err.serial}`,
      VOUCHER_NO_BALANCE: `잔액이 없는 상품권입니다: ${err.serial}`,
      PRODUCT_NOT_FOUND: '존재하지 않는 제품입니다.',
      PRODUCT_DELETED: '판매가 중단된 제품입니다.',
      OUT_OF_STOCK: `재고가 부족합니다. (재고: ${err.stock})`,
      INSUFFICIENT_BALANCE: `상품권 잔액 합계가 부족합니다. (잔액 합계: ${(err.totalBalance||0).toLocaleString()}원, 필요: ${(err.totalPrice||0).toLocaleString()}원)`,
    };
    const status = (err.code === 'VOUCHER_NOT_FOUND' || err.code === 'PRODUCT_NOT_FOUND') ? 404 : 400;
    return res.status(status).json({ success: false, error: messages[err.code] || err.code });
  }

  res.status(201).json({
    success: true,
    data: {
      order: result.order,
      usages: result.usages,
      vouchers: result.vouchers,
      voucher: result.voucher,
    }
  });
}));

// 주문 목록 (관리자)
app.get('/api/orders', auth.requireAdmin, ah(async (req, res) => {
  const rows = await db.orders.list();
  res.json({ success: true, data: rows });
}));

// 주문 상태 변경 (관리자)
app.put('/api/orders/:id/status', auth.requireAdmin, ah(async (req, res) => {
  const { status } = req.body;
  const allowed = ['pending', 'preparing', 'shipped', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, error: '유효하지 않은 상태입니다.' });
  }

  const result = await db.orders.updateStatus(req.params.id, status);
  if (result.notFound) return res.status(404).json({ success: false, error: '주문을 찾을 수 없습니다.' });

  if (result.error) {
    const err = result.error;
    const messages = {
      VOUCHER_NOT_FOUND: `복원 불가: 상품권을 찾을 수 없습니다 (${err.serial}).`,
      INSUFFICIENT_BALANCE_RESTORE: `복원 불가: 상품권 ${err.serial} 잔액(${(err.balance||0).toLocaleString()}원)이 부족하여 ${(err.needed||0).toLocaleString()}원을 다시 차감할 수 없습니다.`,
      OUT_OF_STOCK_RESTORE: `복원 불가: 제품 재고가 부족합니다. (필요 ${err.needed}개, 현재 ${err.stock}개)`,
    };
    return res.status(400).json({ success: false, error: messages[err.code] || err.code });
  }

  res.json({
    success: true,
    data: result.order,
    restored: !!result.restored,
    restored_vouchers: result.restored_vouchers,
    restored_stock: result.restored_stock,
    rededucted: !!result.rededucted,
  });
}));

// ─────────────────────────────────────────────
// 페이지 라우트
// ─────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'login.html'));
});

app.get(['/admin', '/admin/'], (req, res) => {
  const token = auth.extractToken(req);
  if (!token || !auth.verify(token)) {
    return res.redirect('/admin/login');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

// 공통 에러 핸들러
app.use((err, req, res, next) => {
  console.error('[Unhandled]', err);
  res.status(500).json({ success: false, error: err.message || '서버 오류' });
});

// Vercel 등 외부 환경에서는 listen 하지 않고 app만 export
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎁 하원나라 서버 실행 중 (${db._type || 'unknown'} 모드)`);
    console.log(`   - 쇼핑몰:   http://localhost:${PORT}/`);
    console.log(`   - 관리자:   http://localhost:${PORT}/admin\n`);
  });
}

module.exports = app;
