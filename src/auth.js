/**
 * 간단한 토큰 기반 관리자 인증 모듈
 * - 메모리 세션 스토어 (재시작 시 초기화됨)
 * - 환경변수로 자격증명 오버라이드 가능
 */
const crypto = require('crypto');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 8; // 8시간

// token -> { username, expiresAt }
const sessions = new Map();

function cleanupExpired() {
  const now = Date.now();
  for (const [token, sess] of sessions) {
    if (sess.expiresAt < now) sessions.delete(token);
  }
}

function login(username, password) {
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return null;
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  return token;
}

function logout(token) {
  return sessions.delete(token);
}

function verify(token) {
  cleanupExpired();
  const sess = sessions.get(token);
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return sess;
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

/**
 * Express 미들웨어: 관리자 권한 확인
 */
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
