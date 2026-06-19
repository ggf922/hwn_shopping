/**
 * Stateless 관리자 인증 모듈 (JWT-style, HMAC-SHA256 서명)
 *
 * 변경 이력
 *  - v1: 메모리 Map 기반 세션 저장 → Serverless(Vercel)에서 Lambda 인스턴스 간
 *        세션 공유가 되지 않아 매 요청마다 401 발생하는 문제 있었음.
 *  - v2 (현재): JWT-style 토큰. 서버가 상태를 들고 있지 않으므로 어떤
 *        Lambda 인스턴스에서도 동일하게 검증 가능.
 *
 * 외부 인터페이스 (server.js 와의 호환)는 v1 그대로 유지합니다:
 *   - login(username, password) -> token | null
 *   - logout(token)             -> true   (stateless 라 noop; 클라이언트 측 토큰 폐기로 충분)
 *   - verify(token)             -> { username, expiresAt } | null
 *   - extractToken(req)         -> token | null
 *   - requireAdmin(req,res,next)
 *   - ADMIN_USERNAME
 */
const crypto = require('crypto');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8시간

// ─────────────────────────────────────────────────────────────
// JWT 서명 시크릿
// ─────────────────────────────────────────────────────────────
// 우선순위:
//   1) JWT_SECRET           (권장 — Vercel 환경변수로 직접 지정)
//   2) ADMIN_PASSWORD 파생  (사용자가 비밀번호 바꾸면 모든 세션 자동 무효화되는 부수효과)
//   3) 무작위 메모리 값     (개발/샌드박스용 fallback. Lambda 재기동 시 세션 무효화됨)
//
// 운영 환경(VERCEL=1)에서는 반드시 JWT_SECRET 을 명시적으로 설정하길 권장.
// 미설정 시에도 ADMIN_PASSWORD 기반으로 동작하므로 즉시 장애가 나진 않지만,
// 비밀번호를 바꾸면 발급되어 있던 모든 토큰이 무효화됩니다.
function resolveSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  // ADMIN_PASSWORD 파생 (해시해서 사용 — 평문 노출 방지)
  if (process.env.ADMIN_PASSWORD) {
    return crypto
      .createHash('sha256')
      .update('hawonnara:' + process.env.ADMIN_PASSWORD)
      .digest('hex');
  }
  // 마지막 fallback (개발용)
  if (!global.__HAWONNARA_FALLBACK_SECRET__) {
    global.__HAWONNARA_FALLBACK_SECRET__ = crypto.randomBytes(32).toString('hex');
    if (process.env.VERCEL) {
      console.warn('[auth] WARNING: JWT_SECRET 미설정 + ADMIN_PASSWORD 미설정 — 무작위 메모리 시크릿 사용 (Lambda 재기동 시 모든 세션 무효화됨)');
    }
  }
  return global.__HAWONNARA_FALLBACK_SECRET__;
}

// ─────────────────────────────────────────────────────────────
// Base64URL (RFC 7515) — Node 표준 base64에 패딩 제거 + URL-safe 치환
// ─────────────────────────────────────────────────────────────
function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecodeToBuffer(str) {
  // 패딩 복원
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ─────────────────────────────────────────────────────────────
// 서명 / 검증
// ─────────────────────────────────────────────────────────────
function sign(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', resolveSecret()).update(data).digest();
  return `${data}.${base64urlEncode(sig)}`;
}

function verifyAndDecode(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  let expected;
  try {
    expected = crypto.createHmac('sha256', resolveSecret()).update(data).digest();
  } catch {
    return null;
  }
  const actual = base64urlDecodeToBuffer(s);
  // 길이 다르면 timingSafeEqual이 throw — 미리 거름
  if (actual.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(actual, expected)) return null;

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
function login(username, password) {
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return null;
  }
  const now = Date.now();
  const payload = {
    sub: username,           // subject
    iat: now,                // issued-at  (ms)
    exp: now + TOKEN_TTL_MS  // expires-at (ms)
  };
  return sign(payload);
}

// stateless 이므로 서버측에서 폐기할 상태가 없음.
// 클라이언트가 localStorage/cookie 에서 토큰을 지우는 것으로 사실상 로그아웃 처리됨.
// (서버측 강제 로그아웃이 필요해지면 JWT_SECRET 을 회전시키면 모든 세션이 무효화됨)
function logout(/* token */) {
  return true;
}

function verify(token) {
  const payload = verifyAndDecode(token);
  if (!payload) return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  if (!payload.sub) return null;
  // 비밀번호가 바뀐 직후라면 resolveSecret() 결과가 달라져 서명 검증 단계에서 이미 실패함.
  // 그래도 보수적으로 sub != 현재 ADMIN_USERNAME 인 토큰은 거부.
  if (payload.sub !== ADMIN_USERNAME) return null;
  return { username: payload.sub, expiresAt: payload.exp };
}

function extractToken(req) {
  // 헤더 우선
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  // 쿠키 fallback
  const cookie = req.headers.cookie;
  if (cookie) {
    const m = cookie.match(/admin_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

function requireAdmin(req, res, next) {
  const token = extractToken(req);
  const sess = token ? verify(token) : null;
  if (!sess) {
    return res.status(401).json({ success: false, error: '인증이 필요합니다.', code: 'UNAUTHORIZED' });
  }
  req.admin = sess;
  next();
}

module.exports = {
  login,
  logout,
  verify,
  extractToken,
  requireAdmin,
  ADMIN_USERNAME
};
