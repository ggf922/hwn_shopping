/**
 * 하원나라 Phase 3 - 기존 이미지 88개를 Supabase Storage(product-images)로 업로드
 *
 * 사용법:
 *   DRY-RUN (실제 업로드 없이 시뮬레이션):
 *     node migration/06_upload_images.js --dry-run
 *
 *   실제 업로드:
 *     node migration/06_upload_images.js
 *
 *   특정 파일만:
 *     node migration/06_upload_images.js --only=product-1779461376485-a1r5xu.png
 *
 * 안전장치:
 *   - DRY-RUN을 먼저 권장
 *   - 이미 존재하는 파일은 skip (멱등)
 *   - 업로드 후 HEAD 검증
 *   - 실패 시 즉시 중단(--continue 옵션으로 무시 가능)
 */
'use strict';

// Node 20 WebSocket polyfill (supabase-js 호환)
try { globalThis.WebSocket = require('ws'); } catch (_) {}

require('dotenv').config({ path: require('path').join(__dirname, '.env.migration') });

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ migration/.env.migration 에 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(1);
}

const BUCKET = 'product-images';
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'uploads');

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const CONTINUE = args.includes('--continue');
const onlyArg  = args.find(a => a.startsWith('--only='));
const ONLY     = onlyArg ? onlyArg.split('=')[1] : null;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

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

async function listExistingObjects() {
  // Storage list — bucket 내 객체 목록
  const existing = new Set();
  let offset = 0;
  const limit = 1000;
  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET).list('', {
      limit, offset, sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw new Error('listExistingObjects 실패: ' + error.message);
    if (!data || data.length === 0) break;
    for (const obj of data) existing.add(obj.name);
    if (data.length < limit) break;
    offset += limit;
  }
  return existing;
}

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  하원나라 Phase 3 - 이미지 Storage 이관');
  console.log(`  모드: ${DRY_RUN ? '🔍 DRY-RUN (시뮬레이션)' : '🚀 실제 업로드'}`);
  if (ONLY)  console.log(`  필터: --only=${ONLY}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 0) 디스크의 이미지 목록
  if (!fs.existsSync(UPLOAD_DIR)) {
    console.error('❌ public/uploads 디렉터리가 없습니다.');
    process.exit(1);
  }
  let files = fs.readdirSync(UPLOAD_DIR).filter(f => !f.startsWith('.'));
  if (ONLY) files = files.filter(f => f === ONLY);
  console.log(`📂 디스크 대상: ${files.length}개`);

  // 1) Storage에 이미 있는 파일
  console.log('🔎 Storage 기존 객체 조회...');
  const existing = await listExistingObjects();
  console.log(`🗂️  Storage 기존: ${existing.size}개`);

  // 2) 업로드
  let uploaded = 0;
  let skipped  = 0;
  let failed   = 0;
  const failedList = [];

  for (const filename of files) {
    const filePath = path.join(UPLOAD_DIR, filename);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) continue;
    if (stat.size === 0) {
      console.log(`  ⏭  ${filename} (0 bytes, 건너뜀)`);
      skipped++;
      continue;
    }
    if (existing.has(filename)) {
      console.log(`  ✅ ${filename} (이미 존재, 건너뜀)`);
      skipped++;
      continue;
    }

    const sizeKb = (stat.size / 1024).toFixed(1);
    const mime = mimeOf(filename);

    if (DRY_RUN) {
      console.log(`  🔍 [DRY] ${filename}  (${sizeKb}KB, ${mime})`);
      uploaded++;
      continue;
    }

    try {
      const buf = fs.readFileSync(filePath);
      const { error } = await supabase.storage.from(BUCKET).upload(filename, buf, {
        contentType: mime,
        upsert: false,        // 이미 있으면 에러 (위에서 미리 걸렀지만 방어)
        cacheControl: '31536000'  // 1년 캐시 (이미지 파일명에 timestamp+rand 들어가서 사실상 immutable)
      });
      if (error) throw error;

      // HEAD 검증 — Public URL 가져와서 객체 존재 확인은 list로 대체 가능
      console.log(`  ⬆️  ${filename}  (${sizeKb}KB, ${mime})`);
      uploaded++;
    } catch (e) {
      failed++;
      failedList.push({ filename, error: e.message });
      console.error(`  ❌ ${filename}: ${e.message}`);
      if (!CONTINUE) {
        console.error('🛑 첫 실패에서 중단합니다. --continue 로 무시 가능');
        break;
      }
    }
  }

  // 3) 사후 검증
  if (!DRY_RUN && uploaded > 0) {
    console.log('');
    console.log('🔎 사후 검증 (Storage 재조회)...');
    const after = await listExistingObjects();
    console.log(`🗂️  Storage 현재: ${after.size}개`);
    // 디스크 파일이 모두 Storage에 존재하는지
    const missing = files.filter(f => !after.has(f) && fs.statSync(path.join(UPLOAD_DIR, f)).size > 0);
    if (missing.length === 0) {
      console.log('✅ 디스크의 모든 비어있지 않은 파일이 Storage에 존재합니다.');
    } else {
      console.log(`⚠️  누락 ${missing.length}개: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}`);
    }
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  결과: 업로드 ${uploaded} | 건너뜀 ${skipped} | 실패 ${failed}`);
  if (failedList.length) {
    console.log('  실패 목록:');
    for (const f of failedList) console.log(`    - ${f.filename}: ${f.error}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  process.exit(failed > 0 && !CONTINUE ? 1 : 0);
}

main().catch(err => {
  console.error('💥 치명적 오류:', err);
  process.exit(2);
});
