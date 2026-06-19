/**
 * 하원나라 - 이미지 Storage 추상화
 *
 * 두 가지 모드를 지원:
 *   1. Supabase Storage 모드 (production, USE_SUPABASE_STORAGE=true 또는 USE_SUPABASE=true)
 *       - 업로드 → Supabase Storage(bucket=product-images)
 *       - /uploads/<filename> 요청 → Storage Public URL 로 302 redirect
 *   2. 로컬 디스크 모드 (sandbox, 기본)
 *       - 업로드 → public/uploads/ 디스크
 *       - /uploads/<filename> 요청 → express.static 에서 서빙
 *
 * 의도:
 *   - DB에 저장된 image_url 값(예: "/uploads/product-XXX.png")은 변경 없음
 *   - 프론트엔드 코드 변경 없음
 *   - sandbox 와 production 양쪽에서 같은 코드가 동작
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// 모드 판정
// ─────────────────────────────────────────────
// 명시적으로 USE_SUPABASE_STORAGE=true 또는,
// Supabase DB 모드를 쓰면(USE_SUPABASE=true) 자동으로 Storage도 활성화.
const USE_STORAGE =
  String(process.env.USE_SUPABASE_STORAGE || '').toLowerCase() === 'true' ||
  String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';

const BUCKET = process.env.STORAGE_BUCKET || 'product-images';
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

// 디스크 모드용: 디렉터리 생성
if (!fs.existsSync(UPLOAD_DIR)) {
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
}

// ─────────────────────────────────────────────
// Supabase 클라이언트 (지연 초기화)
// ─────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  // Node 20 ws polyfill
  try { if (!globalThis.WebSocket) globalThis.WebSocket = require('ws'); } catch (_) {}
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('Storage 모드인데 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다.');
  }
  _supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }});
  return _supabase;
}

function modeName() {
  return USE_STORAGE ? `supabase-storage (bucket=${BUCKET})` : 'local-disk';
}

// ─────────────────────────────────────────────
// 파일명 안전화
// ─────────────────────────────────────────────
function safeName(originalname) {
  const ext = (path.extname(originalname || '') || '.jpg').toLowerCase();
  return `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

function mimeOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif':  return 'image/gif';
    default:      return 'application/octet-stream';
  }
}

// ─────────────────────────────────────────────
// 업로드
// ─────────────────────────────────────────────
/**
 * @param {Buffer} buffer
 * @param {string} originalname
 * @param {string} [mimetype]
 * @returns {Promise<{ filename: string, url: string, size: number }>}
 *   url 은 DB에 저장할 상대 경로 "/uploads/<filename>"
 */
async function uploadBuffer(buffer, originalname, mimetype) {
  if (!buffer || !buffer.length) {
    throw new Error('업로드할 파일이 비어 있습니다.');
  }
  const filename = safeName(originalname);
  const contentType = mimetype || mimeOf(filename);

  if (USE_STORAGE) {
    const sb = getSupabase();
    const { error } = await sb.storage.from(BUCKET).upload(filename, buffer, {
      contentType,
      upsert: false,
      cacheControl: '31536000'  // 1년 (파일명에 timestamp+rand 들어가서 immutable)
    });
    if (error) {
      throw new Error('Supabase Storage 업로드 실패: ' + error.message);
    }
  } else {
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, buffer);
  }

  return {
    filename,
    url: `/uploads/${filename}`,   // DB 저장값 (양쪽 모드 동일)
    size: buffer.length
  };
}

// ─────────────────────────────────────────────
// 공개 URL 조회 (디버그용)
// ─────────────────────────────────────────────
function getPublicUrl(filename) {
  if (USE_STORAGE) {
    const sb = getSupabase();
    return sb.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
  }
  return `/uploads/${filename}`;
}

// ─────────────────────────────────────────────
// Express 라우트 핸들러: GET /uploads/:filename
//   - Storage 모드: Storage Public URL 로 302 redirect
//   - 디스크 모드: express.static 으로 위임 (이 핸들러는 마운트 안 됨)
// ─────────────────────────────────────────────
function handleUploadsRequest(req, res, next) {
  if (!USE_STORAGE) return next();   // express.static 이 처리하도록

  // 파일명 추출 + 안전화 (.., / 등 위험 문자 차단)
  const raw = req.params.filename || '';
  const filename = path.basename(raw);    // .. 제거
  if (!filename || filename !== raw) {
    return res.status(400).send('잘못된 파일명');
  }
  // 허용 확장자만 통과
  if (!/\.(jpe?g|png|webp|gif)$/i.test(filename)) {
    return res.status(400).send('지원하지 않는 파일 형식');
  }

  try {
    const sb = getSupabase();
    const publicUrl = sb.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl;
    // 짧은 캐시 (브라우저가 redirect 결과는 캐싱)
    res.set('Cache-Control', 'public, max-age=300');  // 5분
    return res.redirect(302, publicUrl);
  } catch (e) {
    console.error('[storage] /uploads redirect 실패:', e.message);
    return res.status(500).send('이미지 서비스 오류');
  }
}

module.exports = {
  USE_STORAGE,
  BUCKET,
  modeName,
  safeName,
  mimeOf,
  uploadBuffer,
  getPublicUrl,
  handleUploadsRequest,
};
