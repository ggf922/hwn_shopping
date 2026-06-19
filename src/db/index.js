/**
 * ============================================================================
 * 데이터베이스 어댑터 팩토리
 * ============================================================================
 * 환경변수 USE_SUPABASE 에 따라 SQLite 또는 Supabase 어댑터를 선택합니다.
 *
 *   USE_SUPABASE=false (또는 미설정) → SQLite (기존 동작 유지, sandbox용)
 *   USE_SUPABASE=true              → Supabase (Vercel 배포용)
 *
 * 모든 어댑터는 동일한 비동기 인터페이스를 제공합니다:
 *   - products.list({ includeDeleted })
 *   - products.get(id)
 *   - products.create(data)
 *   - products.update(id, data)
 *   - products.remove(id) → { mode: 'hard'|'soft' }
 *   - products.move(id, direction)
 *   - products.reorder(ids)
 *
 *   - vouchers.list({ includeDeleted })
 *   - vouchers.get(serial)
 *   - vouchers.create({ amount, quantity, generateSerial })
 *   - vouchers.remove(serial) → { mode: 'hard'|'soft', distinctOrderCount }
 *
 *   - voucherAmounts.list()
 *   - voucherAmounts.create(amount)
 *   - voucherAmounts.remove(id)
 *   - voucherAmounts.getValidAmounts() → [number]
 *
 *   - orders.list()  → 각 주문에 usages 포함
 *   - orders.get(id) → usages 포함
 *   - orders.create({ serials, product_id, quantity, recipient_* })
 *       → { order, usages, vouchers, voucher }
 *   - orders.updateStatus(id, newStatus)
 *       → { order, restored, restored_vouchers?, restored_stock?, rededucted? }
 *
 *   - admin.stats() (선택)
 * ============================================================================
 */

const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';

let adapter;
if (USE_SUPABASE) {
    console.log('[DB] 🌐 Supabase 어댑터 사용 (USE_SUPABASE=true)');
    adapter = require('./supabase-adapter');
} else {
    console.log('[DB] 💾 SQLite 어댑터 사용 (로컬/sandbox)');
    adapter = require('./sqlite-adapter');
}

module.exports = adapter;
