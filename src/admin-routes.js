/**
 * ============================================================================
 * 관리자 대시보드 + 발주서 라우트 등록
 * ============================================================================
 * server.js 에서 한 줄로 등록할 수 있도록 분리된 모듈.
 * 
 * 사용:
 *   const registerAdminRoutes = require('./admin-routes');
 *   registerAdminRoutes(app);   // 일반 라우트 정의 이후, 페이지 라우트 이전에 호출
 * 
 * 등록되는 라우트:
 *   GET  /admin/dashboard               → dashboard.html
 *   GET  /admin/po                      → po.html
 *   GET  /api/admin/stats/summary       → 결산 데이터
 *   GET  /api/admin/stats/vouchers      → 상품권 통계
 *   GET  /api/admin/stats/customers     → 고객 분석
 *   GET  /api/admin/po/orders           → 발주서 주문 (공급사별)
 *   GET  /api/admin/suppliers           → 공급사 목록
 *   POST /api/admin/suppliers           → 공급사 추가
 *   GET  /api/admin/products-supplier   → 상품-공급사 매핑 목록
 *   PUT  /api/admin/products-supplier   → 매핑 변경
 * ============================================================================
 */

const path = require('path');
const auth = require('./auth');
const stats = require('./db/admin-stats');

// async 라우트 catch 헬퍼 (server.js의 ah와 동일 패턴)
function ah(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function registerAdminRoutes(app) {
    // ─── 대시보드 페이지 ─────────────────────────
    app.get('/admin/dashboard', ah(async (req, res) => {
        const token = auth.extractToken(req);
        const sess = token ? await auth.verify(token) : null;
        if (!sess) return res.redirect('/admin/login');
        res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'dashboard.html'));
    }));

    // ─── 발주서 페이지 ───────────────────────────
    app.get('/admin/po', ah(async (req, res) => {
        const token = auth.extractToken(req);
        const sess = token ? await auth.verify(token) : null;
        if (!sess) return res.redirect('/admin/login');
        res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'po.html'));
    }));

    // ─── 통계 API ────────────────────────────────
    app.get('/api/admin/stats/summary', auth.requireAdmin, ah(async (req, res) => {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ success: false, error: 'start, end 파라미터가 필요합니다 (YYYY-MM-DD)' });
        }
        const data = await stats.summary(start, end);
        res.json({ success: true, data });
    }));

    app.get('/api/admin/stats/vouchers', auth.requireAdmin, ah(async (req, res) => {
        const data = await stats.vouchers();
        res.json({ success: true, data });
    }));

    app.get('/api/admin/stats/customers', auth.requireAdmin, ah(async (req, res) => {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ success: false, error: 'start, end 파라미터가 필요합니다' });
        }
        const data = await stats.customers(start, end);
        res.json({ success: true, data });
    }));

    // ─── 발주서 API ──────────────────────────────
    app.get('/api/admin/po/orders', auth.requireAdmin, ah(async (req, res) => {
        const { start, end } = req.query;
        if (!start || !end) {
            return res.status(400).json({ success: false, error: 'start, end 파라미터가 필요합니다 (KST 타임스탬프)' });
        }
        const data = await stats.poOrders(start, end);
        res.json({ success: true, data });
    }));

    // ─── 공급사 ─────────────────────────────────
    app.get('/api/admin/suppliers', auth.requireAdmin, ah(async (req, res) => {
        const data = await stats.suppliers.list();
        res.json({ success: true, data });
    }));

    app.post('/api/admin/suppliers', auth.requireAdmin, ah(async (req, res) => {
        const { name, format_type } = req.body || {};
        if (!name) return res.status(400).json({ success: false, error: '공급사 이름이 필요합니다' });
        const data = await stats.suppliers.add(name.trim(), format_type);
        res.json({ success: true, data });
    }));

    // ─── 상품-공급사 매핑 ───────────────────────
    app.get('/api/admin/products-supplier', auth.requireAdmin, ah(async (req, res) => {
        const data = await stats.products.listForMap();
        res.json({ success: true, data });
    }));

    app.put('/api/admin/products-supplier', auth.requireAdmin, ah(async (req, res) => {
        const { product_id, supplier_id } = req.body || {};
        if (!product_id) return res.status(400).json({ success: false, error: 'product_id가 필요합니다' });
        const data = await stats.products.setSupplier(
            Number(product_id),
            supplier_id ? Number(supplier_id) : null
        );
        res.json({ success: true, data });
    }));

    console.log('[admin-routes] 관리자 대시보드 + 발주서 라우트 등록 완료');
}

module.exports = registerAdminRoutes;
