/**
 * Vercel Serverless Function 진입점
 *
 * src/server.js 가 Express app 을 export 하도록 만들어져 있어,
 * 이 파일은 그 app 을 그대로 default export 하면 끝.
 *
 * 모든 요청 (/api/*, /uploads/*, 정적이 아닌 모든 경로)이
 * vercel.json 의 rewrites 규칙에 따라 이 함수로 라우팅됨.
 *
 * 정적 파일 (public/*) 은 Vercel CDN 이 직접 서빙하므로
 * 이 함수까지 오지 않음 (rewrites 가 정적 자원은 통과시킴).
 */
'use strict';

// Vercel 환경에서는 항상 Supabase 모드로 강제
// (USE_SUPABASE 환경변수가 set 안 되어 있을 경우의 안전망)
if (process.env.VERCEL && !process.env.USE_SUPABASE) {
  process.env.USE_SUPABASE = 'true';
}
if (process.env.VERCEL && !process.env.USE_SUPABASE_STORAGE) {
  process.env.USE_SUPABASE_STORAGE = 'true';
}

// Express 앱 로드 (require.main !== module 이므로 app.listen() 호출 안 됨)
const app = require('../src/server');

module.exports = app;
