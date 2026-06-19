#!/usr/bin/env node
/**
 * 스키마 생성 검증 스크립트
 */
require('dotenv').config({ path: __dirname + '/.env.migration' });
if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require('ws'); } catch (_) {}
}
const { createClient } = require('@supabase/supabase-js');

const TABLES = ['products', 'vouchers', 'orders', 'order_voucher_usages', 'voucher_amounts'];

(async () => {
    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        { auth: { persistSession: false } }
    );

    console.log('========== 스키마 검증 ==========');
    let allOk = true;
    for (const t of TABLES) {
        const { count, error } = await supabase
            .from(t)
            .select('*', { count: 'exact', head: true });
        if (error) {
            console.log(`❌ ${t.padEnd(25)} 오류: ${error.message}`);
            allOk = false;
        } else {
            console.log(`✅ ${t.padEnd(25)} 테이블 존재 (현재 ${count}행)`);
        }
    }
    if (allOk) {
        console.log('');
        console.log('🎉 모든 테이블이 정상 생성되었습니다!');
        process.exit(0);
    } else {
        console.log('');
        console.log('⚠️  일부 테이블이 누락되었습니다. 01_schema.sql 을 다시 실행해주세요.');
        process.exit(1);
    }
})();
