/**
 * Vercel 배포 사전 시뮬레이션
 *
 * Vercel은 api/index.js의 module.exports 를 (req, res) => void 형태로 호출합니다.
 * Express app 도 (req, res) => void 시그니처라 그대로 동작합니다.
 *
 * 이 스크립트는:
 *   1. Vercel 환경변수 (VERCEL=1, USE_SUPABASE=true 등) 시뮬레이션
 *   2. api/index.js 를 그대로 require 해서 app 받아오기
 *   3. 임의 포트에 listen 시켜 외부에서 동작 확인
 *
 * 즉 "Vercel이 함수를 부르는 흐름"을 그대로 따라하면서, 사실상 같은 코드 경로를 탑니다.
 */
'use strict';

// Vercel 환경 변수 시뮬레이션
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'preview';
process.env.VERCEL_URL = 'simulated.vercel.app';

// .env.migration 에서 Supabase 키 로드 (실제 Vercel 에서는 대시보드 환경변수에서 주입)
require('dotenv').config({ path: require('path').join(__dirname, '.env.migration') });

// USE_SUPABASE 강제 (api/index.js 가 자동으로 set 하지만 명시)
process.env.USE_SUPABASE = 'true';
process.env.USE_SUPABASE_STORAGE = 'true';

// Vercel 환경에서는 SUPABASE_SERVICE_ROLE_KEY 가 SUPABASE_KEY 라는 이름으로
// 들어올 수도 있으니 양쪽 호환되는지 확인용
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Vercel 배포 시뮬레이션');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('환경 변수:');
console.log('  VERCEL                       =', process.env.VERCEL);
console.log('  VERCEL_ENV                   =', process.env.VERCEL_ENV);
console.log('  USE_SUPABASE                 =', process.env.USE_SUPABASE);
console.log('  USE_SUPABASE_STORAGE         =', process.env.USE_SUPABASE_STORAGE);
console.log('  SUPABASE_URL                 =', process.env.SUPABASE_URL ? '✅ set' : '❌ MISSING');
console.log('  SUPABASE_SERVICE_ROLE_KEY    =', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ set' : '❌ MISSING');
console.log('  ADMIN_USERNAME               =', process.env.ADMIN_USERNAME || '(default: admin)');
console.log('  ADMIN_PASSWORD               =', process.env.ADMIN_PASSWORD ? '✅ set (custom)' : '⚠️  default: admin123');
console.log('');

// api/index.js 를 그대로 require → Vercel과 같은 코드 경로
const app = require('../api/index');

// 임의 포트에 listen
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log('');
  console.log(`🎭 Vercel 시뮬레이터 (port ${PORT})`);
  console.log(`   - 쇼핑몰:   http://localhost:${PORT}/`);
  console.log(`   - 관리자:   http://localhost:${PORT}/admin`);
  console.log('');
  console.log('이 시뮬레이터는:');
  console.log('  ✅ api/index.js 경유 (Vercel 과 동일한 진입점)');
  console.log('  ✅ Supabase DB + Storage 사용 (production 동일)');
  console.log('  ✅ /uploads/* → Storage redirect');
  console.log('  ✅ /api/upload → Storage 업로드');
  console.log('');
  console.log('Ctrl+C 로 종료');
});
