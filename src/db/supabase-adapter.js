/**
 * ============================================================================
 * Supabase 어댑터 (@supabase/supabase-js 기반)
 * ============================================================================
 * 같은 인터페이스를 PostgreSQL/Supabase로 구현.
 * 트랜잭션은 PostgreSQL RPC 또는 직접 pg 연결을 사용해야 하지만,
 * 여기서는 application-level lock + 순차 실행으로 처리.
 * ============================================================================
 */

// Node 20 WebSocket 호환
if (typeof globalThis.WebSocket === 'undefined') {
    try { globalThis.WebSocket = require('ws'); } catch (_) {}
}

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('[DB] Supabase 어댑터: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
});

console.log(`[DB] Supabase 연결: ${SUPABASE_URL}`);

// 페이지네이션 helper (Supabase 기본 1000건 제한 우회)
async function selectAll(table, queryFn) {
    const PAGE = 1000;
    let from = 0;
    const all = [];
    while (true) {
        const q = queryFn(supabase.from(table)).range(from, from + PAGE - 1);
        const { data, error } = await q;
        if (error) throw new Error(`[${table}] ${error.message}`);
        all.push(...(data || []));
        if (!data || data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

// 공통 오류 throw
function throwIfError(res, ctx = '') {
    if (res.error) {
        throw new Error(`${ctx} ${res.error.message}${res.error.details ? ' / ' + res.error.details : ''}`);
    }
    return res;
}

// ============================================================================
// products
// ============================================================================
const products = {
    async list({ includeDeleted = false } = {}) {
        return selectAll('products', (q) => {
            let query = q.select('*').order('sort_order', { ascending: true, nullsFirst: false }).order('id', { ascending: true });
            if (!includeDeleted) query = query.eq('is_deleted', 0);
            return query;
        });
    },

    async get(id) {
        const { data, error } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
        if (error) throw new Error(`products.get: ${error.message}`);
        return data || null;
    },

    async create({ name, price, description, image_url, stock }) {
        // 최대 sort_order
        const { data: maxData } = await supabase
            .from('products')
            .select('sort_order')
            .order('sort_order', { ascending: false, nullsFirst: false })
            .limit(1);
        const nextOrder = ((maxData && maxData[0] && maxData[0].sort_order) || 0) + 1;

        const { data, error } = await supabase
            .from('products')
            .insert({
                name,
                price: Number(price),
                description: description || '',
                image_url: image_url || '',
                stock: Number(stock) || 0,
                sort_order: nextOrder,
            })
            .select()
            .single();
        if (error) throw new Error(`products.create: ${error.message}`);
        return data;
    },

    async update(id, { name, price, description, image_url, stock }) {
        const { data: existing } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
        if (!existing) return null;

        const patch = { updated_at: new Date().toISOString() };
        if (name !== undefined) patch.name = name;
        if (price !== undefined && price !== null) patch.price = Number(price);
        if (description !== undefined) patch.description = description;
        if (image_url !== undefined) patch.image_url = image_url;
        if (stock !== undefined && stock !== null) patch.stock = Number(stock);

        const { data, error } = await supabase
            .from('products')
            .update(patch)
            .eq('id', id)
            .select()
            .single();
        if (error) throw new Error(`products.update: ${error.message}`);
        return data;
    },

    async remove(id) {
        const { data: existing } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
        if (!existing) return { notFound: true };

        const { count: orderCount } = await supabase
            .from('orders')
            .select('*', { count: 'exact', head: true })
            .eq('product_id', id);

        if (orderCount === 0) {
            const { error } = await supabase.from('products').delete().eq('id', id);
            if (error) throw new Error(`products.remove (hard): ${error.message}`);
            return { mode: 'hard' };
        }
        const { error } = await supabase
            .from('products')
            .update({ is_deleted: 1, updated_at: new Date().toISOString() })
            .eq('id', id);
        if (error) throw new Error(`products.remove (soft): ${error.message}`);
        return { mode: 'soft', orderCount };
    },

    async move(id, direction) {
        const productId = Number(id);
        const { data: current } = await supabase
            .from('products')
            .select('id, sort_order')
            .eq('id', productId)
            .eq('is_deleted', 0)
            .maybeSingle();
        if (!current) return { notFound: true };

        // 이웃 찾기
        let neighbor;
        if (direction === 'up') {
            const { data } = await supabase
                .from('products')
                .select('id, sort_order')
                .eq('is_deleted', 0)
                .or(`sort_order.lt.${current.sort_order},and(sort_order.eq.${current.sort_order},id.lt.${current.id})`)
                .order('sort_order', { ascending: false })
                .order('id', { ascending: false })
                .limit(1);
            neighbor = data && data[0];
        } else {
            const { data } = await supabase
                .from('products')
                .select('id, sort_order')
                .eq('is_deleted', 0)
                .or(`sort_order.gt.${current.sort_order},and(sort_order.eq.${current.sort_order},id.gt.${current.id})`)
                .order('sort_order', { ascending: true })
                .order('id', { ascending: true })
                .limit(1);
            neighbor = data && data[0];
        }

        if (!neighbor) return { moved: false, atBoundary: true };

        // 스왑 (트랜잭션 대신 안전한 임시 값 활용)
        const tempOrder = -Math.abs(current.sort_order || 0) - 1000000 - Date.now() % 1000;
        const now = new Date().toISOString();

        // 1) current → temp
        await supabase.from('products').update({ sort_order: tempOrder, updated_at: now }).eq('id', current.id);
        // 2) neighbor → current.sort_order
        await supabase.from('products').update({ sort_order: current.sort_order, updated_at: now }).eq('id', neighbor.id);
        // 3) current → neighbor.sort_order
        await supabase.from('products').update({ sort_order: neighbor.sort_order, updated_at: now }).eq('id', current.id);

        return { moved: true };
    },

    async reorder(ids) {
        const now = new Date().toISOString();
        // 안전을 위해 1차로 모두 음수 임시 값으로 옮겨서 충돌 방지
        for (let i = 0; i < ids.length; i++) {
            await supabase.from('products')
                .update({ sort_order: -(i + 1) - 1000000, updated_at: now })
                .eq('id', Number(ids[i]));
        }
        // 2차로 정상 값 부여
        for (let i = 0; i < ids.length; i++) {
            await supabase.from('products')
                .update({ sort_order: i + 1, updated_at: now })
                .eq('id', Number(ids[i]));
        }
        return { count: ids.length };
    },
};

// ============================================================================
// vouchers
// ============================================================================
const vouchers = {
    async list({ includeDeleted = false } = {}) {
        return selectAll('vouchers', (q) => {
            let query = q.select('*').order('issued_at', { ascending: false });
            if (!includeDeleted) query = query.eq('is_deleted', 0);
            return query;
        });
    },

    async get(serial) {
        const { data, error } = await supabase.from('vouchers').select('*').eq('serial', serial).maybeSingle();
        if (error) throw new Error(`vouchers.get: ${error.message}`);
        return data || null;
    },

    async create({ amount, quantity, generateSerial }) {
        const qty = Math.min(Math.max(Number(quantity) || 1, 1), 100);
        const created = [];
        for (let i = 0; i < qty; i++) {
            let serial;
            let attempts = 0;
            while (attempts < 10) {
                serial = generateSerial();
                const { data: exists } = await supabase.from('vouchers').select('id').eq('serial', serial).maybeSingle();
                if (!exists) break;
                attempts++;
            }
            const { data, error } = await supabase
                .from('vouchers')
                .insert({ serial, amount: Number(amount), balance: Number(amount), status: 'active' })
                .select()
                .single();
            if (error) throw new Error(`vouchers.create: ${error.message}`);
            created.push(data);
        }
        return created;
    },

    async remove(serial) {
        const { data: existing } = await supabase.from('vouchers').select('*').eq('serial', serial).maybeSingle();
        if (!existing) return { notFound: true };

        const { count: primaryRefCount } = await supabase
            .from('orders').select('*', { count: 'exact', head: true }).eq('voucher_serial', serial);
        const { count: usageRefCount } = await supabase
            .from('order_voucher_usages').select('*', { count: 'exact', head: true }).eq('voucher_serial', serial);

        const totalRefCount = (primaryRefCount || 0) + (usageRefCount || 0);

        if (totalRefCount === 0) {
            const { error } = await supabase.from('vouchers').delete().eq('serial', serial);
            if (error) throw new Error(`vouchers.remove (hard): ${error.message}`);
            return { mode: 'hard' };
        }

        const { error } = await supabase.from('vouchers').update({ is_deleted: 1 }).eq('serial', serial);
        if (error) throw new Error(`vouchers.remove (soft): ${error.message}`);

        // distinct order ids (orders + usages)
        const { data: orderRows } = await supabase.from('orders').select('id').eq('voucher_serial', serial);
        const { data: usageRows } = await supabase.from('order_voucher_usages').select('order_id').eq('voucher_serial', serial);
        const set = new Set();
        (orderRows || []).forEach(r => set.add(r.id));
        (usageRows || []).forEach(r => set.add(r.order_id));
        return { mode: 'soft', distinctOrderCount: set.size };
    },
};

// ============================================================================
// voucherAmounts
// ============================================================================
const voucherAmounts = {
    async list() {
        const { data, error } = await supabase
            .from('voucher_amounts')
            .select('id, amount, sort_order, is_active')
            .eq('is_active', 1)
            .order('sort_order', { ascending: true })
            .order('amount', { ascending: true });
        if (error) throw new Error(`voucherAmounts.list: ${error.message}`);
        return data || [];
    },

    async getValidAmounts() {
        const list = await this.list();
        return list.map(r => r.amount);
    },

    async create(amount) {
        const { data: existing } = await supabase
            .from('voucher_amounts')
            .select('id, is_active')
            .eq('amount', amount)
            .maybeSingle();

        if (existing) {
            if (existing.is_active === 1) return { duplicate: true };
            const { data, error } = await supabase
                .from('voucher_amounts')
                .update({ is_active: 1 })
                .eq('id', existing.id)
                .select('id, amount, sort_order, is_active')
                .single();
            if (error) throw new Error(`voucherAmounts.create (reactivate): ${error.message}`);
            return { row: data };
        }

        const { data: maxData } = await supabase
            .from('voucher_amounts')
            .select('sort_order')
            .order('sort_order', { ascending: false })
            .limit(1);
        const sortOrder = ((maxData && maxData[0] && maxData[0].sort_order) || 0) + 1;

        const { data, error } = await supabase
            .from('voucher_amounts')
            .insert({ amount, sort_order: sortOrder, is_active: 1 })
            .select('id, amount, sort_order, is_active')
            .single();
        if (error) throw new Error(`voucherAmounts.create: ${error.message}`);
        return { row: data };
    },

    async remove(id) {
        const { data: row } = await supabase.from('voucher_amounts').select('*').eq('id', id).maybeSingle();
        if (!row) return { notFound: true };

        const { count: usedCount } = await supabase
            .from('vouchers').select('*', { count: 'exact', head: true }).eq('amount', row.amount);

        if (usedCount > 0) {
            const { error } = await supabase.from('voucher_amounts').update({ is_active: 0 }).eq('id', id);
            if (error) throw new Error(`voucherAmounts.remove (soft): ${error.message}`);
            return { mode: 'soft', usedCount };
        }
        const { error } = await supabase.from('voucher_amounts').delete().eq('id', id);
        if (error) throw new Error(`voucherAmounts.remove (hard): ${error.message}`);
        return { mode: 'hard' };
    },
};

// ============================================================================
// orders
// ============================================================================
const orders = {
    async list() {
        const rows = await selectAll('orders', (q) => q.select('*').order('created_at', { ascending: false }));
        // 사용 내역 일괄 조회
        const ids = rows.map(r => r.id);
        if (ids.length === 0) return rows;

        const allUsages = await selectAll('order_voucher_usages', (q) =>
            q.select('order_id, voucher_serial, amount_used, sequence').in('order_id', ids).order('sequence', { ascending: true })
        );
        const byOrder = new Map();
        for (const u of allUsages) {
            if (!byOrder.has(u.order_id)) byOrder.set(u.order_id, []);
            byOrder.get(u.order_id).push({ voucher_serial: u.voucher_serial, amount_used: u.amount_used, sequence: u.sequence });
        }
        for (const r of rows) {
            r.usages = byOrder.get(r.id) || [];
        }
        return rows;
    },

    async get(id) {
        const { data: row } = await supabase.from('orders').select('*').eq('id', id).maybeSingle();
        if (!row) return null;
        const { data: usages } = await supabase
            .from('order_voucher_usages')
            .select('voucher_serial, amount_used, sequence')
            .eq('order_id', id)
            .order('sequence', { ascending: true });
        row.usages = usages || [];
        return row;
    },

    async create({ serials, product_id, quantity, recipient }) {
        // 사전 검증
        const vouchersToUse = [];
        for (const s of serials) {
            const { data: v } = await supabase.from('vouchers').select('*').eq('serial', s).maybeSingle();
            if (!v) return { error: { code: 'VOUCHER_NOT_FOUND', serial: s } };
            if (v.is_deleted) return { error: { code: 'VOUCHER_DELETED', serial: s } };
            if (v.status !== 'active') return { error: { code: 'VOUCHER_USED', serial: s } };
            if (v.balance <= 0) return { error: { code: 'VOUCHER_NO_BALANCE', serial: s } };
            vouchersToUse.push(v);
        }

        const { data: product } = await supabase.from('products').select('*').eq('id', product_id).maybeSingle();
        if (!product) return { error: { code: 'PRODUCT_NOT_FOUND' } };
        if (product.is_deleted) return { error: { code: 'PRODUCT_DELETED' } };

        const qty = Math.max(Number(quantity) || 1, 1);
        if (product.stock < qty) return { error: { code: 'OUT_OF_STOCK', stock: product.stock } };

        const totalPrice = product.price * qty;
        const totalBalance = vouchersToUse.reduce((sum, v) => sum + v.balance, 0);
        if (totalBalance < totalPrice) {
            return { error: { code: 'INSUFFICIENT_BALANCE', totalBalance, totalPrice } };
        }

        // 차감 + 주문 생성 (순차적 — Supabase는 다중 statement 트랜잭션 불가)
        let remaining = totalPrice;
        const usages = [];
        const nowIso = new Date().toISOString();

        for (let i = 0; i < vouchersToUse.length && remaining > 0; i++) {
            const v = vouchersToUse[i];
            const take = Math.min(remaining, v.balance);
            const newBalance = v.balance - take;
            const newStatus = newBalance === 0 ? 'used' : 'active';
            const usedAt = newBalance === 0 ? nowIso : v.used_at;

            const { error: e1 } = await supabase
                .from('vouchers')
                .update({ balance: newBalance, status: newStatus, used_at: usedAt })
                .eq('serial', v.serial);
            if (e1) throw new Error(`orders.create voucher update: ${e1.message}`);

            usages.push({ serial: v.serial, amount_used: take, sequence: i + 1 });
            remaining -= take;
        }

        // 재고 차감
        const { error: e2 } = await supabase
            .from('products')
            .update({ stock: product.stock - qty })
            .eq('id', product_id);
        if (e2) throw new Error(`orders.create stock: ${e2.message}`);

        const primarySerial = usages[0].serial;
        const { data: orderRow, error: e3 } = await supabase
            .from('orders')
            .insert({
                voucher_serial: primarySerial,
                product_id,
                product_name: product.name,
                quantity: qty,
                total_price: totalPrice,
                recipient_name: recipient.name || '',
                recipient_phone: recipient.phone || '',
                recipient_zipcode: recipient.zipcode || '',
                recipient_address: recipient.address || '',
                recipient_address_detail: recipient.address_detail || '',
                delivery_memo: recipient.memo || '',
            })
            .select()
            .single();
        if (e3) throw new Error(`orders.create order: ${e3.message}`);

        // 사용 내역 일괄 삽입
        const usageRows = usages.map(u => ({
            order_id: orderRow.id,
            voucher_serial: u.serial,
            amount_used: u.amount_used,
            sequence: u.sequence,
        }));
        const { error: e4 } = await supabase.from('order_voucher_usages').insert(usageRows);
        if (e4) throw new Error(`orders.create usages: ${e4.message}`);

        // 결과 조회
        const updatedVouchers = [];
        for (const s of serials) {
            const { data } = await supabase.from('vouchers').select('*').eq('serial', s).maybeSingle();
            updatedVouchers.push(data);
        }

        return {
            order: orderRow,
            usages,
            vouchers: updatedVouchers,
            voucher: updatedVouchers[0],
        };
    },

    async updateStatus(id, newStatus) {
        const orderId = Number(id);
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
        if (!order) return { notFound: true };

        const prevStatus = order.status || 'pending';
        if (prevStatus === newStatus) return { order, restored: false, noChange: true };

        const { data: usages } = await supabase
            .from('order_voucher_usages')
            .select('voucher_serial, amount_used, sequence')
            .eq('order_id', orderId)
            .order('sequence', { ascending: true });

        const effectiveUsages = (usages && usages.length > 0)
            ? usages
            : [{ voucher_serial: order.voucher_serial, amount_used: order.total_price, sequence: 1 }];

        // CASE 1: 취소로 전환 → 복원
        if (prevStatus !== 'cancelled' && newStatus === 'cancelled') {
            for (const u of effectiveUsages) {
                const { data: v } = await supabase.from('vouchers').select('*').eq('serial', u.voucher_serial).maybeSingle();
                if (!v) continue;
                const newBalance = v.balance + u.amount_used;
                const vStatus = newBalance > 0 ? 'active' : v.status;
                const newUsedAt = newBalance > 0 ? null : v.used_at;
                await supabase
                    .from('vouchers')
                    .update({ balance: newBalance, status: vStatus, used_at: newUsedAt })
                    .eq('serial', u.voucher_serial);
            }
            // 제품 재고 복원
            const { data: prod } = await supabase.from('products').select('stock').eq('id', order.product_id).maybeSingle();
            const newStock = (prod ? prod.stock : 0) + order.quantity;
            await supabase.from('products').update({ stock: newStock }).eq('id', order.product_id);

            await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
            const { data: updated } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();

            // 복원된 상품권 결과
            const restoredVouchers = [];
            for (const u of effectiveUsages) {
                const { data: v } = await supabase.from('vouchers').select('*').eq('serial', u.voucher_serial).maybeSingle();
                restoredVouchers.push({ serial: u.voucher_serial, amount_restored: u.amount_used, voucher: v });
            }
            return { order: updated, restored: true, restored_vouchers: restoredVouchers, restored_stock: order.quantity };
        }

        // CASE 2: 취소 → 활성 (재차감)
        if (prevStatus === 'cancelled' && newStatus !== 'cancelled') {
            // 사전 검증
            for (const u of effectiveUsages) {
                const { data: v } = await supabase.from('vouchers').select('*').eq('serial', u.voucher_serial).maybeSingle();
                if (!v) return { error: { code: 'VOUCHER_NOT_FOUND', serial: u.voucher_serial } };
                if (v.balance < u.amount_used) {
                    return { error: { code: 'INSUFFICIENT_BALANCE_RESTORE', serial: u.voucher_serial, balance: v.balance, needed: u.amount_used } };
                }
            }
            const { data: product } = await supabase.from('products').select('*').eq('id', order.product_id).maybeSingle();
            if (!product || product.stock < order.quantity) {
                return { error: { code: 'OUT_OF_STOCK_RESTORE', needed: order.quantity, stock: product ? product.stock : 0 } };
            }

            // 차감 실행
            for (const u of effectiveUsages) {
                const { data: v } = await supabase.from('vouchers').select('*').eq('serial', u.voucher_serial).maybeSingle();
                const newBalance = v.balance - u.amount_used;
                const vStatus = newBalance === 0 ? 'used' : 'active';
                const newUsedAt = newBalance === 0 ? new Date().toISOString() : v.used_at;
                await supabase
                    .from('vouchers')
                    .update({ balance: newBalance, status: vStatus, used_at: newUsedAt })
                    .eq('serial', u.voucher_serial);
            }
            await supabase.from('products').update({ stock: product.stock - order.quantity }).eq('id', order.product_id);
            await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
            const { data: updated } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            return { order: updated, restored: false, rededucted: true };
        }

        // CASE 3: 단순 상태 변경
        await supabase.from('orders').update({ status: newStatus }).eq('id', orderId);
        const { data: updated } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
        return { order: updated, restored: false };
    },
};

// ─────────────────────────────────────────────
// 관리자 설정 (key-value)
//   - admin_settings 테이블 필요. Supabase SQL 에디터에서 1회 실행:
//     CREATE TABLE IF NOT EXISTS public.admin_settings (
//       key text PRIMARY KEY,
//       value text NOT NULL,
//       updated_at timestamptz NOT NULL DEFAULT now()
//     );
//   - 테이블이 아직 없는 경우 get() 은 null을 반환하고
//     set() 은 에러를 throw 합니다 (운영자가 SQL 실행 필요).
// ─────────────────────────────────────────────
const adminSettings = {
    async get(key) {
        try {
            const { data, error } = await supabase
                .from('admin_settings')
                .select('value')
                .eq('key', key)
                .maybeSingle();
            if (error) {
                // 테이블 미생성 등 — 환경변수 fallback 으로 동작하도록 null 반환
                console.warn('[adminSettings.get] ', error.message);
                return null;
            }
            return data ? data.value : null;
        } catch (e) {
            console.warn('[adminSettings.get] ', e.message);
            return null;
        }
    },

    async set(key, value) {
        const { error } = await supabase
            .from('admin_settings')
            .upsert(
                { key, value: String(value), updated_at: new Date().toISOString() },
                { onConflict: 'key' }
            );
        if (error) {
            throw new Error(`admin_settings 저장 실패: ${error.message} (Supabase에 admin_settings 테이블이 있는지 확인하세요)`);
        }
        return true;
    },
};

module.exports = {
    products,
    vouchers,
    voucherAmounts,
    orders,
    adminSettings,
    _raw: supabase,
    _type: 'supabase',
};
