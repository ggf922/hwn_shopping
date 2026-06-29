/**
 * ============================================================================
 * 관리자 통계 + 발주서 데이터 어댑터
 * ============================================================================
 * 결산 대시보드와 발주서 페이지를 위한 집계 쿼리들.
 * 기존 supabase-adapter의 _raw 클라이언트를 재사용 (USE_SUPABASE=true 환경에서만 동작).
 * 
 * 메서드:
 *   - summary(start, end)    → 대시보드 핵심 KPI + 일별/시간/지역/상태/상품/최근주문
 *   - vouchers()             → 상품권 발행/사용 통계
 *   - customers(start, end)  → 고객 분석 (VIP, 재구매, 신규vs재구매)
 *   - poOrders(start, end)   → 발주서용 (공급사별 그룹)
 *   - suppliers.list()       → 공급사 목록 + 상품 수
 *   - suppliers.add(name, format_type)
 *   - products.listForMap()  → 상품 + 매핑된 공급사명
 *   - products.setSupplier(productId, supplierId)
 * ============================================================================
 */

const db = require('./index');

if (db._type !== 'supabase') {
    console.warn('[admin-stats] Supabase 모드가 아닙니다. 대시보드 API는 USE_SUPABASE=true 환경에서만 동작합니다.');
}
const sb = db._raw;

const STATUS_KR = {
    pending: '결제완료', preparing: '배송준비',
    shipped: '배송중', delivered: '배송완료', cancelled: '취소',
};
const VOUCHER_STATUS_KR = { active: '사용가능', used: '사용완료' };

// ─── 헬퍼: KST 변환 ─────────────────────────────────────
function toKstDate(isoUtc) {
    if (!isoUtc) return null;
    const d = new Date(isoUtc);
    if (isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 9 * 3600 * 1000);
}
function toKstDateStr(isoUtc) {
    const d = toKstDate(isoUtc);
    if (!d) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function kstDateToUtcRange(startDate, endDate) {
    const startUtc = new Date(`${startDate}T00:00:00+09:00`).toISOString();
    const endPlus = new Date(endDate);
    endPlus.setDate(endPlus.getDate() + 1);
    const endStr = endPlus.toISOString().slice(0, 10);
    const endUtc = new Date(`${endStr}T00:00:00+09:00`).toISOString();
    return { startUtc, endUtc };
}
function kstStrToUtcIso(kstStr) {
    if (!kstStr) return null;
    return new Date(kstStr.replace(' ', 'T') + '+09:00').toISOString();
}

// 시도 정규화
function extractRegion(addr) {
    if (!addr) return null;
    const first = String(addr).trim().split(/\s+/)[0];
    const map = {
        '서울':'서울특별시','서울시':'서울특별시','서울특별시':'서울특별시',
        '부산':'부산광역시','부산시':'부산광역시','부산광역시':'부산광역시',
        '대구':'대구광역시','대구시':'대구광역시','대구광역시':'대구광역시',
        '인천':'인천광역시','인천시':'인천광역시','인천광역시':'인천광역시',
        '광주':'광주광역시','광주시':'광주광역시','광주광역시':'광주광역시',
        '대전':'대전광역시','대전시':'대전광역시','대전광역시':'대전광역시',
        '울산':'울산광역시','울산시':'울산광역시','울산광역시':'울산광역시',
        '세종':'세종특별자치시','세종시':'세종특별자치시',
        '경기':'경기도','경기도':'경기도',
        '강원':'강원특별자치도','강원도':'강원특별자치도',
        '충북':'충청북도','충청북도':'충청북도',
        '충남':'충청남도','충청남도':'충청남도',
        '전북':'전북특별자치도','전라북도':'전북특별자치도',
        '전남':'전라남도','전라남도':'전라남도',
        '경북':'경상북도','경상북도':'경상북도',
        '경남':'경상남도','경상남도':'경상남도',
        '제주':'제주특별자치도','제주도':'제주특별자치도',
    };
    return map[first] || first;
}

// 페이지네이션 fetch
async function fetchAll(table, configure) {
    const PAGE = 1000;
    let from = 0;
    const all = [];
    while (true) {
        let q = configure(sb.from(table)).range(from, from + PAGE - 1);
        const { data, error } = await q;
        if (error) throw new Error(`[${table}] ${error.message}`);
        all.push(...(data || []));
        if (!data || data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

// ─── 대시보드 ─────────────────────────────────────
async function summary(start, end) {
    const { startUtc, endUtc } = kstDateToUtcRange(start, end);
    const orders = await fetchAll('orders', q => q
        .select('id, product_name, quantity, total_price, recipient_name, recipient_address, status, created_at')
        .gte('created_at', startUtc)
        .lt('created_at', endUtc)
        .order('created_at', { ascending: false }));

    const valid = orders.filter(o => o.status !== 'cancelled');
    const cancelled = orders.filter(o => o.status === 'cancelled');
    const revenue = valid.reduce((s, o) => s + (o.total_price || 0), 0);
    const qty = valid.reduce((s, o) => s + (o.quantity || 0), 0);
    const customers = new Set(valid.map(o => o.recipient_name).filter(Boolean));
    const products = new Set(valid.map(o => o.product_name).filter(Boolean));
    const aov = valid.length > 0 ? Math.round(revenue / valid.length) : 0;

    const dailyMap = new Map();
    for (const o of valid) {
        const d = toKstDateStr(o.created_at);
        if (!d) continue;
        const cur = dailyMap.get(d) || { day: d, orders: 0, revenue: 0 };
        cur.orders++;
        cur.revenue += (o.total_price || 0);
        dailyMap.set(d, cur);
    }
    const dailyTrend = Array.from(dailyMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    const statusMap = new Map();
    for (const o of orders) {
        const cur = statusMap.get(o.status) || { status: o.status, status_kr: STATUS_KR[o.status] || o.status, orders: 0, revenue: 0 };
        cur.orders++;
        cur.revenue += (o.total_price || 0);
        statusMap.set(o.status, cur);
    }
    const statusDist = Array.from(statusMap.values()).sort((a, b) => b.orders - a.orders);

    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0, revenue: 0 }));
    for (const o of valid) {
        const d = toKstDate(o.created_at);
        if (!d) continue;
        hourly[d.getUTCHours()].orders++;
        hourly[d.getUTCHours()].revenue += (o.total_price || 0);
    }

    const regionMap = new Map();
    for (const o of valid) {
        const r = extractRegion(o.recipient_address) || '미상';
        const cur = regionMap.get(r) || { region: r, orders: 0, revenue: 0 };
        cur.orders++;
        cur.revenue += (o.total_price || 0);
        regionMap.set(r, cur);
    }
    const region = Array.from(regionMap.values()).sort((a, b) => b.revenue - a.revenue);

    const productMap = new Map();
    for (const o of valid) {
        const k = o.product_name || '(미상)';
        const cur = productMap.get(k) || { product_name: k, qty: 0, orders: 0, revenue: 0 };
        cur.qty += (o.quantity || 0);
        cur.orders++;
        cur.revenue += (o.total_price || 0);
        productMap.set(k, cur);
    }
    const topProducts = Array.from(productMap.values())
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

    const recentOrders = orders.slice(0, 100).map(o => ({
        ...o,
        status_kr: STATUS_KR[o.status] || o.status,
        region: extractRegion(o.recipient_address),
        ordered_at_kst: toKstDate(o.created_at)?.toISOString().slice(0, 19).replace('T', ' '),
    }));

    return {
        period: { start, end, days: dailyTrend.length },
        kpis: {
            total_orders: orders.length,
            valid_orders: valid.length,
            cancelled: cancelled.length,
            revenue,
            quantity_sold: qty,
            avg_order_value: aov,
            unique_customers: customers.size,
            unique_products: products.size,
        },
        dailyTrend, statusDist, hourly, region, topProducts, recentOrders,
    };
}

// ─── 상품권 통계 ─────────────────────────────────
async function vouchers() {
    const rows = await fetchAll('vouchers', q => q
        .select('amount, balance, status, is_deleted')
        .order('id', { ascending: true }));
    const active = rows.filter(v => !v.is_deleted);

    const total_issued = active.length;
    const total_face = active.reduce((s, v) => s + (v.amount || 0), 0);
    const used_amt = active.reduce((s, v) => s + ((v.amount || 0) - (v.balance || 0)), 0);
    const remaining_amt = active.reduce((s, v) => s + (v.balance || 0), 0);
    const fully_used = active.filter(v => v.status === 'used').length;
    const partial = active.filter(v => v.status === 'active' && v.balance < v.amount).length;
    const unused = active.filter(v => v.status === 'active' && v.balance === v.amount).length;
    const use_rate = total_face > 0 ? +(100.0 * used_amt / total_face).toFixed(1) : 0;
    const avg_face_value = total_issued > 0 ? Math.round(total_face / total_issued) : 0;

    const byFace = new Map();
    for (const v of active) {
        const k = v.amount;
        const cur = byFace.get(k) || { face_value: k, issued: 0, used: 0, partial: 0, unused: 0, total_face: 0, used_amount: 0 };
        cur.issued++;
        cur.total_face += (v.amount || 0);
        cur.used_amount += ((v.amount || 0) - (v.balance || 0));
        if (v.status === 'used') cur.used++;
        else if (v.status === 'active' && v.balance < v.amount) cur.partial++;
        else if (v.status === 'active' && v.balance === v.amount) cur.unused++;
        byFace.set(k, cur);
    }
    const byFaceValue = Array.from(byFace.values())
        .sort((a, b) => b.face_value - a.face_value)
        .map(r => ({ ...r, use_pct: r.total_face > 0 ? +(100.0 * r.used_amount / r.total_face).toFixed(1) : 0 }));

    return { summary: { total_issued, total_face, used_amt, remaining_amt, use_rate, fully_used, partial, unused, avg_face_value }, byFaceValue };
}

// ─── 고객 분석 ─────────────────────────────────
async function customers(start, end) {
    const { startUtc, endUtc } = kstDateToUtcRange(start, end);
    const allOrders = await fetchAll('orders', q => q
        .select('recipient_name, total_price, created_at, status')
        .neq('status', 'cancelled')
        .not('recipient_name', 'is', null)
        .order('id', { ascending: true }));

    const firstByCust = new Map();
    for (const o of allOrders) {
        const d = toKstDateStr(o.created_at);
        const cur = firstByCust.get(o.recipient_name);
        if (!cur || d < cur) firstByCust.set(o.recipient_name, d);
    }
    const inWindow = allOrders.filter(o => o.created_at >= startUtc && o.created_at < endUtc);

    const custMap = new Map();
    for (const o of inWindow) {
        const cur = custMap.get(o.recipient_name) || {
            recipient: o.recipient_name, orders: 0, total_spent: 0,
            first_order_in_window: null, last_order_in_window: null,
        };
        cur.orders++;
        cur.total_spent += (o.total_price || 0);
        const d = toKstDateStr(o.created_at);
        if (!cur.first_order_in_window || d < cur.first_order_in_window) cur.first_order_in_window = d;
        if (!cur.last_order_in_window || d > cur.last_order_in_window) cur.last_order_in_window = d;
        custMap.set(o.recipient_name, cur);
    }
    const custList = Array.from(custMap.values());
    const total = custList.length;
    const repeat = custList.filter(c => c.orders >= 2).length;
    const loyal = custList.filter(c => c.orders >= 3).length;
    const avgOrders = total > 0 ? +(custList.reduce((s, c) => s + c.orders, 0) / total).toFixed(1) : 0;
    const avgLTV = total > 0 ? Math.round(custList.reduce((s, c) => s + c.total_spent, 0) / total) : 0;
    const topValue = custList.reduce((m, c) => Math.max(m, c.total_spent), 0);

    const top10 = [...custList].sort((a, b) => b.total_spent - a.total_spent).slice(0, 10)
        .map(c => ({ recipient: c.recipient, orders: c.orders, total_spent: c.total_spent, first_order: c.first_order_in_window, last_order: c.last_order_in_window }));

    const dayMap = new Map();
    for (const o of inWindow) {
        const d = toKstDateStr(o.created_at);
        const firstEver = firstByCust.get(o.recipient_name);
        const isNew = firstEver === d;
        const cur = dayMap.get(d) || { day: d, new_orders: 0, returning_orders: 0, new_customers: new Set(), returning_customers: new Set() };
        if (isNew) { cur.new_orders++; cur.new_customers.add(o.recipient_name); }
        else { cur.returning_orders++; cur.returning_customers.add(o.recipient_name); }
        dayMap.set(d, cur);
    }
    const newVsReturning = Array.from(dayMap.values()).sort((a, b) => a.day.localeCompare(b.day))
        .map(r => ({ day: r.day, new_orders: r.new_orders, returning_orders: r.returning_orders, new_customers: r.new_customers.size, returning_customers: r.returning_customers.size }));

    return {
        summary: {
            total_customers: total,
            repeat_customers: repeat,
            loyal_customers: loyal,
            avg_orders_per_customer: avgOrders,
            avg_lifetime_value: avgLTV,
            top_customer_value: topValue,
        },
        top10, newVsReturning,
    };
}

// ─── 발주서 ─────────────────────────────────────
async function poOrders(startKst, endKst) {
    const startUtc = kstStrToUtcIso(startKst);
    const endUtc = kstStrToUtcIso(endKst);

    const orders = await fetchAll('orders', q => q
        .select('id, product_id, product_name, quantity, total_price, recipient_name, recipient_phone, recipient_zipcode, recipient_address, recipient_address_detail, delivery_memo, status, created_at')
        .gte('created_at', startUtc)
        .lt('created_at', endUtc)
        .neq('status', 'cancelled')
        .order('id', { ascending: true }));

    if (orders.length === 0) return { groups: [], total_orders: 0, period: { start: startKst, end: endKst } };

    const productIds = Array.from(new Set(orders.map(o => o.product_id).filter(Boolean)));
    const { data: products } = await sb.from('products')
        .select('id, name, supplier_id')
        .in('id', productIds.length > 0 ? productIds : [-1]);
    const productSupplierMap = new Map((products || []).map(p => [p.id, p.supplier_id]));

    const { data: suppliers } = await sb.from('suppliers').select('id, name, format_type');
    const supplierMap = new Map((suppliers || []).map(s => [s.id, s]));

    const groupMap = new Map();
    for (const o of orders) {
        const supplierId = productSupplierMap.get(o.product_id) || null;
        const supplier = supplierId ? supplierMap.get(supplierId) : null;
        const key = supplier ? supplier.id : 0;
        if (!groupMap.has(key)) {
            groupMap.set(key, {
                supplier_id: supplier?.id || 0,
                supplier_name: supplier?.name || '미지정',
                format_type: supplier?.format_type || 'standard',
                orders: [],
            });
        }
        groupMap.get(key).orders.push({
            order_no: '#' + o.id,
            product_id: o.product_id,
            product_name: o.product_name,
            quantity: o.quantity,
            recipient: o.recipient_name,
            phone: o.recipient_phone,
            postal_code: o.recipient_zipcode,
            address: o.recipient_address,
            address_detail: o.recipient_address_detail,
            delivery_memo: o.delivery_memo,
            status: o.status,
            status_kr: STATUS_KR[o.status] || o.status,
            ordered_at: o.created_at,
        });
    }
    const groups = Array.from(groupMap.values()).sort((a, b) => b.orders.length - a.orders.length);
    return { groups, total_orders: orders.length, period: { start: startKst, end: endKst } };
}

// ─── 공급사 관리 ────────────────────────────────
const suppliers = {
    async list() {
        const { data: sup } = await sb.from('suppliers')
            .select('id, name, format_type, contact, email')
            .order('name', { ascending: true });
        const { data: prods } = await sb.from('products')
            .select('supplier_id')
            .eq('is_deleted', 0);
        const cnt = new Map();
        for (const p of (prods || [])) cnt.set(p.supplier_id, (cnt.get(p.supplier_id) || 0) + 1);
        return (sup || []).map(s => ({ ...s, product_count: cnt.get(s.id) || 0 }))
            .sort((a, b) => b.product_count - a.product_count);
    },
    async add(name, format_type) {
        const ft = format_type === 'nangman' ? 'nangman' : 'standard';
        const { data, error } = await sb.from('suppliers')
            .upsert({ name, format_type: ft }, { onConflict: 'name' })
            .select('id, name, format_type')
            .single();
        if (error) throw new Error(error.message);
        return data;
    },
};

const productsHelpers = {
    async listForMap() {
        const { data: products } = await sb.from('products')
            .select('id, name, price, supplier_id')
            .eq('is_deleted', 0)
            .order('name', { ascending: true });
        const { data: sup } = await sb.from('suppliers').select('id, name');
        const supMap = new Map((sup || []).map(s => [s.id, s.name]));
        return (products || []).map(p => ({ ...p, supplier_name: supMap.get(p.supplier_id) || null }));
    },
    async setSupplier(productId, supplierId) {
        const { error } = await sb.from('products')
            .update({ supplier_id: supplierId || null })
            .eq('id', productId);
        if (error) throw new Error(error.message);
        return { product_id: productId, supplier_id: supplierId };
    },
};

module.exports = {
    summary,
    vouchers,
    customers,
    poOrders,
    suppliers,
    products: productsHelpers,
};
