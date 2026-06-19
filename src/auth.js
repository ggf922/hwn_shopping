/**
 * Stateless 관리자 인증 모듈 (JWT-style, HMAC-SHA256 서명)
 *
 * 변경 이력
 *  - v1: 메모리 Map 기반 세션 저장 → Serverless(Vercel)에서 Lambda 인스턴스 간
 *        세션 공유가 되지 않아 매 요청마다 401 발생하는 문제 있었음.
 *  - v2: JWT-style 토큰. 서버가 상태를 들고 있지 않으므로 어떤
 *        Lambda 인스턴스에서도 동일하게 검증 가능.
 *  - v3 (현재): 비밀번호를 DB(admin_settings)에 PBKDF2 해시로 저장 가능.
 *        DB에 해시가 있으면 그 값을 사용, 없으면 환경변수 ADMIN_PASSWORD 사용(하위호환).
 *        비밀번호 변경 시 JWT 서명 시크릿이 바뀌어 기존 모든 세션이 자동 무효화됨.
 *
 * 외부 인터페이스 (server.js 와의 호환):
 *   - login(username, password) -> Promise<token | null>
 *   - logout(token)             -> true  (stateless 라 noop)
 *   - verify(token)             -> Promise<{ username, expiresAt } | null>
 *   - extractToken(req)         -> token | null
 *   - requireAdmin(req,res,next)
 *   - changePassword(current, next) -> Promise<{ ok: true } | { ok: false, error }>
 *   - ADMIN_USERNAME
 */
const crypto = require('crypto');
const db = require('./db');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ENV_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8시간

// DB 키
const DB_KEY_PASSWORD_HASH = 'admin_password_hash';

// PBKDF2 파라미터
const PBKDF2_ITER = 100000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';
const PBKDF2_SALT_LEN = 16;

// ─────────────────────────────────────────────────────────────
// 비밀번호 해시 (PBKDF2)
//   포맷: pbkdf2$<iter>$<saltB64>$<hashB64>
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(PBKDF2_SALT_LEN);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITER, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  return `pbkdf2$${PBKDF2_ITER}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPasswordHash(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = parseInt(parts[1], 10);
  if (!Number.isFinite(iter) || iter < 1000 || iter > 1_000_000) return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[2], 'base64');
    expected = Buffer.from(parts[3], 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  let actual;
  try {
    actual = crypto.pbkdf2Sync(password, salt, iter, expected.length, PBKDF2_DIGEST);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 현재 유효한 비밀번호 해시 / 평문 의존성 조회
//   - DB 에 hash 가 있으면 그것을 사용 (운영자가 비밀번호를 변경한 상태)
//   - 없으면 환경변수 ADMIN_PASSWORD 의 평문 (최초/하위호환)
//
// 반환값:
//   { source: 'db'|'env',
//     hashed: string|null,   // PBKDF2 포맷
//     plain:  string|null }  // 평문 (source==='env' 일 때만)
// ─────────────────────────────────────────────────────────────
async function getCurrentPasswordRecord() {
  let stored = null;
  try {
    if (db.adminSettings && typeof db.adminSettings.get === 'function') {
      stored = await db.adminSettings.get(DB_KEY_PASSWORD_HASH);
    }
  } catch (e) {
    console.warn('[auth] admin_settings 조회 실패, 환경변수로 fallback:', e.message);
  }
  if (stored) {
    return { source: 'db', hashed: stored, plain: null };
  }
  return { source: 'env', hashed: null, plain: ENV_ADMIN_PASSWORD };
}

async function verifyPasswordAgainstCurrent(password) {
  if (typeof password !== 'string' || password.length === 0) return false;
  const rec = await getCurrentPasswordRecord();
  if (rec.source === 'db') {
    return verifyPasswordHash(password, rec.hashed);
  }
  // env 평문 비교 — 타이밍 공격 방지 위해 길이 다르더라도 안정적으로 비교
  const a = Buffer.from(password, 'utf8');
  const b = Buffer.from(rec.plain || '', 'utf8');
  if (a.length !== b.length) {
    // 길이 자체가 정보를 흘리지 않도록 더미 비교 수행 후 false 반환
    try { crypto.timingSafeEqual(a, a); } catch {}
    return false;
  }
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// JWT 서명 시크릿
//   우선순위:
//     1) JWT_SECRET (env)                          ← 가장 안정적, 외부에서 회전 가능
//     2) DB 해시 기반 파생 (해시문자열 자체를 시크릿으로 사용)
//        → 비밀번호 바꾸면 시크릿도 자동 변경 → 모든 기존 세션 무효화
//     3) 환경변수 ADMIN_PASSWORD 파생 (하위호환)
//     4) 랜덤 메모리 시크릿 (개발용 fallback)
// ─────────────────────────────────────────────────────────────
async function resolveSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  const rec = await getCurrentPasswordRecord();
  if (rec.source === 'db' && rec.hashed) {
    // 해시 문자열 자체로부터 시크릿 파생
    return crypto.createHash('sha256').update('hawonnara:hash:' + rec.hashed).digest('hex');
  }
  if (rec.plain) {
    return crypto.createHash('sha256').update('hawonnara:' + rec.plain).digest('hex');
  }
  if (!global.__HAWONNARA_FALLBACK_SECRET__) {
    global.__HAWONNARA_FALLBACK_SECRET__ = crypto.randomBytes(32).toString('hex');
    if (process.env.VERCEL) {
      console.warn('[auth] WARNING: JWT_SECRET 미설정 + 비밀번호 미설정 — 무작위 메모리 시크릿 사용');
    }
  }
  return global.__HAWONNARA_FALLBACK_SECRET__;
}

// ─────────────────────────────────────────────────────────────
// Base64URL (RFC 7515)
// ─────────────────────────────────────────────────────────────
function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecodeToBuffer(str) {
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ─────────────────────────────────────────────────────────────
// 서명 / 검증 (async — resolveSecret 이 async 이므로)
// ─────────────────────────────────────────────────────────────
async function sign(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const secret = await resolveSecret();
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${base64urlEncode(sig)}`;
}

async function verifyAndDecode(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  let expected;
  try {
    const secret = await resolveSecret();
    expected = crypto.createHmac('sha256', secret).update(data).digest();
  } catch {
    return null;
  }
  const actual = base64urlDecodeToBuffer(s);
  if (actual.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(actual, expected)) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToBuffer(p).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  return payload;
}

// ─────────────────────────────────────────────────────────────
// 외부 API
// ─────────────────────────────────────────────────────────────
async function login(username, password) {
  if (username !== ADMIN_USERNAME) return null;
  const ok = await verifyPasswordAgainstCurrent(password);
  if (!ok) return null;
  const now = Date.now();
  return sign({ sub: username, iat: now, exp: now + TOKEN_TTL_MS });
}

function logout(/* token */) {
  return true;
}

async function verify(token) {
  const payload = await verifyAndDecode(token);
  if (!payload) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (!payload.sub || payload.sub !== ADMIN_USERNAME) return null;
  return { username: payload.sub, expiresAt: payload.exp };
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = cookie.match(/admin_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function requireAdmin(req, res, next) {
  const token = extractToken(req);
  const sess = token ? await verify(token) : null;
  if (!sess) {
    return res.status(401).json({ success: false, error: '인증이 필요합니다.', code: 'UNAUTHORIZED' });
  }
  req.admin = sess;
  next();
}

// ─────────────────────────────────────────────────────────────
// 비밀번호 변경
//   - 현재 비밀번호 검증 후 새 비밀번호 해시를 DB 에 저장
//   - 저장 직후 JWT 서명 시크릿이 자동으로 바뀌므로 기존 토큰 모두 무효화됨
//
// 반환:
//   { ok: true }
//   { ok: false, error: '...', code: '...' }
// ─────────────────────────────────────────────────────────────
async function changePassword(currentPassword, newPassword) {
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return { ok: false, code: 'BAD_REQUEST', error: '입력값이 올바르지 않습니다.' };
  }
  if (newPassword.length < 8) {
    return { ok: false, code: 'TOO_SHORT', error: '새 비밀번호는 최소 8자 이상이어야 합니다.' };
  }
  if (newPassword.length > 200) {
    return { ok: false, code: 'TOO_LONG', error: '새 비밀번호가 너무 깁니다.' };
  }
  if (currentPassword === newPassword) {
    return { ok: false, code: 'SAME_PASSWORD', error: '새 비밀번호가 현재 비밀번호와 동일합니다.' };
  }
  const ok = await verifyPasswordAgainstCurrent(currentPassword);
  if (!ok) {
    return { ok: false, code: 'WRONG_PASSWORD', error: '현재 비밀번호가 올바르지 않습니다.' };
  }
  if (!db.adminSettings || typeof db.adminSettings.set !== 'function') {
    return { ok: false, code: 'STORAGE_UNAVAILABLE', error: '비밀번호를 저장할 수 없습니다. (admin_settings 미지원)' };
  }
  const newHash = hashPassword(newPassword);
  try {
    await db.adminSettings.set(DB_KEY_PASSWORD_HASH, newHash);
  } catch (e) {
    return { ok: false, code: 'STORAGE_FAILED', error: e.message || '비밀번호 저장에 실패했습니다.' };
  }
  return { ok: true };
}

module.exports = {
  login,
  logout,
  verify,
  extractToken,
  requireAdmin,
  changePassword,
  ADMIN_USERNAME,
  // 내부 테스트용
  _hashPassword: hashPassword,
  _verifyPasswordHash: verifyPasswordHash,
};
