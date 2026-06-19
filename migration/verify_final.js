#!/usr/bin/env node
/**
 * 시퀀스 재조정 후 최종 검증
 */
require('dotenv').config({ path: __dirname + '/.env.migration' });
if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require('ws'); } catch (_) {}
}
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

(async () => {
    console.log('========================================');
    console.log('  Phase 1 최종 검증');
    console.log('========================================\n');

    // 1) admin_stats 뷰 호출
    console.log('[1/3] admin_stats 뷰 조회');
    const { data: stats, error: statsErr } = await supabase
        .from('admin_stats')
        .select('*')
        .single();
    if (statsErr) {
        console.log('  ⚠️ admin_stats 조회 실패:', statsErr.message);
    } else {
        console.log(`  활성 상품 수:        ${stats.active_products}`);
        console.log(`  활성 상품권 수:      ${stats.active_vouchers}`);
        console.log(`  총 주문 수:          ${stats.total_orders}`);
        console.log(`  총 매출:             ${stats.total_revenue.toLocaleString()}원`);
        console.log(`  활성 발권 금액 옵션: ${stats.active_amount_options}개`);
    }
    console.log('');

    // 2) 새 행 추가 테스트 (시퀀스 충돌 검사)
    console.log('[2/3] 시퀀스 충돌 테스트 (테스트용 voucher_amounts 추가)');
    const testAmount = 999999999; // 충돌 없을 고유 값
    
    // 기존에 같은 amount 있으면 먼저 정리
    await supabase.from('voucher_amounts').delete().eq('amount', testAmount);
    
    const { data: inserted, error: insertErr } = await supabase
        .from('voucher_amounts')
        .insert({ amount: testAmount, sort_order: 999, is_active: 0 })
        .select()
        .single();
    if (insertErr) {
        console.log(`  ❌ 삽입 실패: ${insertErr.message}`);
        if (insertErr.message.includes('duplicate key')) {
            console.log('  → 시퀀스가 재조정되지 않은 것 같습니다. 03_finalize.sql 다시 실행 필요');
        }
    } else {
        console.log(`  ✅ 새 ID 발급 성공: id=${inserted.id} (충돌 없음)`);
        // 테스트 데이터 정리
        await supabase.from('voucher_amounts').delete().eq('id', inserted.id);
        console.log(`  ✅ 테스트 데이터 정리 완료`);
    }
    console.log('');

    // 3) RLS 확인 (anon key로 접근 시 막혀야 정상)
    console.log('[3/3] RLS 보안 검증 (anon key로는 접근 차단되어야 정상)');
    const anonSupabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY,
        { auth: { persistSession: false } }
    );
    const { data: anonData, error: anonErr } = await anonSupabase
        .from('vouchers')
        .select('serial')
        .limit(1);
    
    if (anonErr || !anonData || anonData.length === 0) {
        console.log(`  ✅ RLS 정상 작동: anon으로 vouchers 접근 차단됨`);
        if (anonErr) console.log(`     (${anonErr.message})`);
    } else {
        console.log(`  ⚠️ anon key로 vouchers 접근 가능! RLS 정책 점검 필요`);
        console.log(`     반환된 행 수: ${anonData.length}`);
    }
    console.log('');

    console.log('========================================');
    console.log('  🎉 Phase 1 완료!');
    console.log('========================================');
})().catch(e => {
    console.error('오류:', e);
    process.exit(1);
});
