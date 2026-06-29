/**
 * 하원나라 상품권 + 쇼핑몰 서버 (어댑터 패턴 적용)
 *
 * 환경변수:
 *   USE_SUPABASE=true          → Supabase DB 모드 (Vercel/Production)
 *   USE_SUPABASE_STORAGE=true  → Supabase Storage 모드 (이미지)
 *                                 (USE_SUPABASE=true 이면 자동 활성)
 *   미설정 또는 false           → SQLite + 로컬 디스크 (sandbox)
 */
const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('./db');
const storage = require('./storage');     // 새 추상화 레이어
const { generateFullSerial, renderVoucherImage } = require('./voucher');
const auth = require('./auth');
const registerAdminRoutes = require('./admin-routes');


const app = express();
const PORT = process.env.PORT || 3000;

console.log(`[storage] 모드: ${storage.modeName()}`);

// ─────────────────────────────────────────────
// multer: 메모리 저장 (디스크/Storage 어느 쪽이든 통일)
//   - 메모리 저장 후 storage.uploadBuffer() 가 디스크 or Supabase 로 라우팅
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
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

// ─────────────────────────────────────────────
// /uploads/<filename> 라우팅
//   - Supabase Storage 모드: Storage Public URL 로 302 redirect
//   - 로컬 디스크 모드: 그냥 express.static 에서 서빙 (아래 정적 미들웨어에서 처리)
// ─────────────────────────────────────────────
if (storage.USE_STORAGE) {
  app.get('/uploads/:filename', storage.handleUploadsRequest);
}

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
app.post('/api/auth/login', ah(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
  }
  const token = await auth.login(username, password);
  if (!token) {
    return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }
  res.json({ success: true, data: { token, username } });
}));

app.post('/api/auth/logout', (req, res) => {
  const token = auth.extractToken(req);
  if (token) auth.logout(token);
  res.json({ success: true });
});

app.get('/api/auth/me', ah(async (req, res) => {
  const token = auth.extractToken(req);
  const sess = token ? await auth.verify(token) : null;
  if (!sess) {
    return res.status(401).json({ success: false, error: '인증 필요' });
  }
  res.json({ success: true, data: { username: sess.username } });
}));

// 관리자 비밀번호 변경
app.post('/api/auth/change-password', auth.requireAdmin, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: '현재 비밀번호와 새 비밀번호를 모두 입력해주세요.' });
  }
  const result = await auth.changePassword(String(currentPassword), String(newPassword));
  if (!result.ok) {
    const status =
      result.code === 'WRONG_PASSWORD' ? 401 :
      result.code === 'STORAGE_FAILED' || result.code === 'STORAGE_UNAVAILABLE' ? 500 :
      400;
    return res.status(status).json({ success: false, error: result.error, code: result.code });
  }
  // 비밀번호 변경 직후 JWT 시크릿이 바뀌어 현재 토큰도 무효화됨 → 프론트가 재로그인 유도
  res.json({ success: true, message: '비밀번호가 변경되었습니다. 다시 로그인 해주세요.' });
}));

// ─────────────────────────────────────────────
// 이미지 업로드 API (관리자 전용)
//   - multer.memoryStorage() 로 buffer 받아 storage.uploadBuffer() 로 위임
//   - 로컬 디스크 또는 Supabase Storage 중 환경에 맞게 자동 라우팅
// ─────────────────────────────────────────────
app.post('/api/upload', auth.requireAdmin, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: '파일이 없습니다.' });
    try {
      const result = await storage.uploadBuffer(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype
      );
      res.json({ success: true, data: result });
    } catch (e) {
      console.error('[/api/upload] 실패:', e);
      res.status(500).json({ success: false, error: e.message || '업로드 실패' });
    }
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

// ─────────────────────────────────────────────
// 주문 내역 조회 (공개, 비회원용 비회원 주문조회)
//
// 보안 / 개인정보 정책
//   - 이름만 입력해도 조회 가능 (사용자 요구사항)
//   - 단, 이름만으로는 동명이인 가능성 + 개인정보 노출 위험 → 응답을 마스킹
//   - 이름 + 휴대폰 뒷 4자리 모두 일치하는 경우에만 마스킹 해제 (본인 확인)
//   - 이름은 완전 일치 (양옆 공백만 trim) — 부분 일치는 의도적으로 차단 (남의 주문 스캐닝 방지)
//   - 결과는 최대 20건, created_at DESC
//
// Query params
//   name     (required) — 받는 분 이름 (정확히 일치)
//   phone4   (optional) — 휴대폰 번호 마지막 4자리 (정확히 일치 시 마스킹 해제)
// ─────────────────────────────────────────────
app.get('/api/orders/lookup', ah(async (req, res) => {
  const name = String(req.query.name || '').trim();
  const phone4Raw = String(req.query.phone4 || '').trim();

  if (!name) {
    return res.status(400).json({ success: false, error: '받는 분 이름을 입력해주세요.' });
  }
  if (name.length > 50) {
    return res.status(400).json({ success: false, error: '이름이 너무 깁니다.' });
  }

  // phone4 는 숫자 4자리만 허용 (옵션)
  let phone4 = null;
  if (phone4Raw) {
    if (!/^\d{4}$/.test(phone4Raw)) {
      return res.status(400).json({ success: false, error: '휴대폰 뒷 4자리는 숫자 4자리로 입력해주세요.' });
    }
    phone4 = phone4Raw;
  }

  // 전체 주문에서 이름 정확 일치 필터 (어댑터 무관하게 동작하도록 메모리 필터링)
  // — 데이터셋이 크지 않은 도메인이므로 성능 문제 없음. 큰 규모면 어댑터에 lookup 메서드 추가 권장.
  const all = await db.orders.list();
  let matched = all.filter(o => (o.recipient_name || '').trim() === name);

  // 본인 확인 여부 판단 (이름 + phone4 모두 일치)
  // 각 주문별로 개별 검사 (같은 이름이라도 다른 사람일 수 있음)
  const out = matched.slice(0, 20).map(o => {
    const phone = String(o.recipient_phone || '');
    const phoneDigits = phone.replace(/\D/g, '');
    const last4 = phoneDigits.slice(-4);
    const verified = phone4 && last4 && last4 === phone4;

    if (verified) {
      // 본인 확인됨 → 그대로 반환 (단 voucher_serial 등 민감 정보 제외)
      return {
        id: o.id,
        created_at: o.created_at,
        product_name: o.product_name,
        quantity: o.quantity,
        total_price: o.total_price,
        status: o.status || 'pending',
        recipient_name: o.recipient_name,
        recipient_phone: o.recipient_phone,
        recipient_zipcode: o.recipient_zipcode,
        recipient_address: o.recipient_address,
        recipient_address_detail: o.recipient_address_detail,
        delivery_memo: o.delivery_memo,
        verified: true,
      };
    }

    // 마스킹 모드: 이름만 일치하는 익명 조회
    return {
      id: o.id,
      created_at: o.created_at,
      product_name: o.product_name,
      quantity: o.quantity,
      total_price: o.total_price,
      status: o.status || 'pending',
      recipient_name: o.recipient_name,
      recipient_phone: maskPhone(o.recipient_phone),
      recipient_zipcode: o.recipient_zipcode ? '*****' : '',
      recipient_address: maskAddress(o.recipient_address),
      recipient_address_detail: o.recipient_address_detail ? '***' : '',
      delivery_memo: '', // 메모는 항상 숨김 (개인적인 내용일 수 있음)
      verified: false,
    };
  });

  res.json({
    success: true,
    data: out,
    meta: {
      count: out.length,
      verified: !!phone4 && out.some(x => x.verified),
      total_matches: matched.length, // 같은 이름의 주문이 몇 건 있는지 (사용자가 본인 주문 식별에 도움)
    },
  });
}));

// 보조: 전화번호 마스킹 — "010-1234-5678" → "010-****-5678"
function maskPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 4) return '****';
  const last4 = digits.slice(-4);
  if (digits.length <= 7) return `***-${last4}`;
  const prefix = digits.slice(0, 3);
  return `${prefix}-****-${last4}`;
}

// 보조: 주소 마스킹 — 시/도 + 시/군/구 만 노출, 그 뒤는 별표
//   예) "서울특별시 강남구 선릉로93길 10" → "서울특별시 강남구 ***"
function maskAddress(addr) {
  if (!addr) return '';
  const parts = String(addr).trim().split(/\s+/);
  if (parts.length <= 2) return parts.join(' ');
  return parts.slice(0, 2).join(' ') + ' ***';
}

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
   registerAdminRoutes(app);
// 페이지 라우트
// ─────────────────────────────────────────────

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'login.html'));
});

app.get(['/admin', '/admin/'], ah(async (req, res) => {
  const token = auth.extractToken(req);
  const sess = token ? await auth.verify(token) : null;
  if (!sess) {
    return res.redirect('/admin/login');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
}));

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
