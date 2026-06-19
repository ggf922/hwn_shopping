#!/usr/bin/env node
/**
 * 이식 후 무결성 검증 (외래키, 데이터 일치성, 샘플 비교)
 */
require('dotenv').config({ path: __dirname + '/.env.migration' });
if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require('ws'); } catch (_) {}
}
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
);

const BACKUP_JSON = path.join(__dirname, '..', 'backups',
    'snapshot_2026-06-19_13-43-54', 'hawonnara_export.json');

(async () => {
    console.log('========================================');
    console.log('  Supabase 이식 후 무결성 검증');
    console.log('========================================\n');

    const src = JSON.parse(fs.readFileSync(BACKUP_JSON, 'utf-8'));

    // 1) 카운트 비교
    console.log('[1/5] 행 수 비교');
    const tables = ['products', 'vouchers', 'orders', 'order_voucher_usages', 'voucher_amounts'];
    let allMatch = true;
    for (const t of tables) {
        const expected = (src.tables[t] || []).length;
        const { count } = await supabase.from(t).select('*', { count: 'exact', head: true });
        const match = count === expected;
        if (!match) allMatch = false;
        console.log(`  ${t.padEnd(25)} 원본: ${expected.toString().padStart(6)} / Supabase: ${count.toString().padStart(6)} ${match ? '✓' : '✗'}`);
    }
    console.log('');

    // 2) 첫 행 / 마지막 행 샘플 비교 (products)
    console.log('[2/5] products 샘플 비교 (첫 행)');
    const firstProd = src.tables.products[0];
    const { data: p1 } = await supabase.from('products').select('*').eq('id', firstProd.id).single();
    console.log(`  원본 id=${firstProd.id}: ${firstProd.name} / 가격 ${firstProd.price}`);
    console.log(`  Supa id=${p1.id}: ${p1.name} / 가격 ${p1.price}`);
    console.log(`  일치: ${firstProd.name === p1.name && firstProd.price === p1.price ? '✓' : '✗'}`);
    console.log('');

    // 3) vouchers 무작위 샘플 5개 비교
    console.log('[3/5] vouchers 무작위 5개 샘플 비교');
    const sampleVs = [];
    const allVs = src.tables.vouchers;
    for (let i = 0; i < 5; i++) {
        sampleVs.push(allVs[Math.floor(Math.random() * allVs.length)]);
    }
    let voucherMatch = 0;
    for (const sv of sampleVs) {
        const { data } = await supabase.from('vouchers').select('*').eq('serial', sv.serial).single();
        const ok = data && data.amount === sv.amount && data.balance === sv.balance;
        if (ok) voucherMatch++;
        console.log(`  ${sv.serial}: amount=${sv.amount} balance=${sv.balance} status=${sv.status} ${ok ? '✓' : '✗'}`);
    }
    console.log(`  결과: ${voucherMatch}/5 일치`);
    console.log('');

    // 4) 외래키 무결성 (orphan 검사)
    console.log('[4/5] 외래키 무결성 검사');
    
    // Supabase 기본 1000건 제한 우회: range로 페이지네이션
    async function fetchAll(table, column) {
        const PAGE = 1000;
        let from = 0;
        const all = [];
        while (true) {
            const { data, error } = await supabase
                .from(table)
                .select(column)
                .range(from, from + PAGE - 1);
            if (error) throw error;
            all.push(...data);
            if (data.length < PAGE) break;
            from += PAGE;
        }
        return all;
    }

    // orders → vouchers
    const orderVoucherSerials = await fetchAll('orders', 'voucher_serial');
    const allVouchers = await fetchAll('vouchers', 'serial');
    const voucherSerialSet = new Set(allVouchers.map(v => v.serial));
    const orphanOrders = orderVoucherSerials.filter(o => !voucherSerialSet.has(o.voucher_serial));
    console.log(`  orders(${orderVoucherSerials.length}) → vouchers(${allVouchers.length}): ${orphanOrders.length === 0 ? '✓ 모든 FK 정상' : '✗ orphan ' + orphanOrders.length + '건'}`);

    // usages → orders
    const usageOrderIds = await fetchAll('order_voucher_usages', 'order_id');
    const allOrders = await fetchAll('orders', 'id');
    const orderIdSet = new Set(allOrders.map(o => o.id));
    const orphanUsages = usageOrderIds.filter(u => !orderIdSet.has(u.order_id));
    console.log(`  usages(${usageOrderIds.length}) → orders(${allOrders.length}): ${orphanUsages.length === 0 ? '✓ 모든 FK 정상' : '✗ orphan ' + orphanUsages.length + '건'}`);

    // usages → vouchers
    const usageVoucherSerials = await fetchAll('order_voucher_usages', 'voucher_serial');
    const orphanUsageVouchers = usageVoucherSerials.filter(u => !voucherSerialSet.has(u.voucher_serial));
    console.log(`  usages(${usageVoucherSerials.length}) → vouchers(${allVouchers.length}): ${orphanUsageVouchers.length === 0 ? '✓ 모든 FK 정상' : '✗ orphan ' + orphanUsageVouchers.length + '건'}`);

    // 5) 총 매출 계산 비교
    console.log('');
    console.log('[5/5] 비즈니스 데이터 검증');
    const srcRevenue = src.tables.orders
        .filter(o => o.status !== 'cancelled')
        .reduce((sum, o) => sum + (o.total_price || 0), 0);
    const { data: revOrders } = await supabase
        .from('orders')
        .select('total_price, status');
    const supRevenue = revOrders
        .filter(o => o.status !== 'cancelled')
        .reduce((sum, o) => sum + (o.total_price || 0), 0);
    console.log(`  총 매출 (취소 제외)`);
    console.log(`    원본:    ${srcRevenue.toLocaleString()} 원`);
    console.log(`    Supabase: ${supRevenue.toLocaleString()} 원`);
    console.log(`    일치: ${srcRevenue === supRevenue ? '✓' : '✗'}`);

    // 잔액이 0이 아닌 상품권 수
    const srcActive = src.tables.vouchers.filter(v => v.status === 'active' && v.balance > 0).length;
    const { count: supActive } = await supabase
        .from('vouchers')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .gt('balance', 0);
    console.log(`  활성 상품권 수 (balance > 0)`);
    console.log(`    원본:    ${srcActive}`);
    console.log(`    Supabase: ${supActive}`);
    console.log(`    일치: ${srcActive === supActive ? '✓' : '✗'}`);

    console.log('');
    console.log('========================================');
    if (allMatch && orphanOrders.length === 0 && orphanUsages.length === 0 && voucherMatch === 5 && srcRevenue === supRevenue) {
        console.log('  🎉 모든 무결성 검증 통과!');
    } else {
        console.log('  ⚠️  일부 검증 항목 확인 필요');
    }
    console.log('========================================');
})().catch(e => {
    console.error('검증 중 오류:', e);
    process.exit(1);
});
