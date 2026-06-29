// 하원나라 결산 대시보드 - 프론트엔드 로직
// /admin/dashboard 에서 동작. 기존 admin_token (localStorage) 인증을 그대로 씁니다.
(function () {
  'use strict';

  // ── 인증 ──────────────────────────────────────
  function getToken() { return localStorage.getItem('admin_token') || ''; }
  function redirectToLogin() {
    localStorage.removeItem('admin_token');
    window.location.href = '/admin/login';
  }
  async function api(url) {
    const token = getToken();
    if (!token) return redirectToLogin();
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401) return redirectToLogin();
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '요청 실패');
    return data.data;
  }

  // ── 진입 시 인증 확인 ─────────────────────────
  (async () => {
    const token = getToken();
    if (!token) return redirectToLogin();
    try {
      const r = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return redirectToLogin();
      const data = await r.json();
      const username = data.data?.username || 'admin';
      const userInfo = document.getElementById('admin-user-info');
      if (userInfo) userInfo.textContent = `👤 ${username}`;
    } catch { redirectToLogin(); }
  })();

  // 로그아웃 버튼
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + getToken() }
      });
    } catch {}
    redirectToLogin();
  });

  // ── 유틸 ──────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmt = n => (Number(n) || 0).toLocaleString('ko-KR');
  function fmtMoney(n) {
    const v = Number(n) || 0;
    if (v >= 100000000) return (v / 100000000).toFixed(2) + '억';
    if (v >= 10000) return (v / 10000).toFixed(0) + '만';
    return fmt(v);
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function escapeHTML(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function statusBadge(s) {
    const cls = ({ '결제완료': 'badge-paid', '배송중': 'badge-shipping', '배송완료': 'badge-done', '취소': 'badge-cancel', '배송준비': 'badge-shipping' })[s] || 'badge-paid';
    return `<span class="badge-pill ${cls}">${escapeHTML(s)}</span>`;
  }

  let charts = {};
  let dataRange = { min: null, max: null };
  let voucherCache = null;

  // ── 기간 프리셋 ───────────────────────────────
  function presetRange(preset) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const y = new Date(today); y.setDate(y.getDate() - 1);
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
    const lastWeekStart = new Date(weekStart); lastWeekStart.setDate(weekStart.getDate() - 7);
    const lastWeekEnd = new Date(weekStart); lastWeekEnd.setDate(weekStart.getDate() - 1);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    switch (preset) {
      case 'today': return [today, today];
      case 'yesterday': return [y, y];
      case 'week': return [weekStart, today];
      case 'last_week': return [lastWeekStart, lastWeekEnd];
      case 'month': return [monthStart, today];
      case 'last_month': return [lastMonthStart, lastMonthEnd];
      case 'all': return null;
    }
  }
  function setActivePill(preset) {
    document.querySelectorAll('.filter-pill[data-preset]').forEach(p => p.classList.remove('active'));
    if (preset) document.querySelector(`.filter-pill[data-preset="${preset}"]`)?.classList.add('active');
  }
  function diffDays(s, e) { return Math.round((new Date(e) - new Date(s)) / 86400000) + 1; }
  function periodLabel(s, e) { return s === e ? `${s} (1일)` : `${s} → ${e} (${diffDays(s, e)}일간)`; }

  // ── 데이터 범위 알아내기 ──
  async function loadRange() {
    const r = await api('/api/admin/stats/summary?start=2020-01-01&end=' + toISO(new Date()));
    if (r.recentOrders && r.recentOrders.length > 0) {
      const last = r.recentOrders[0].ordered_at_kst?.slice(0, 10);
      const first = r.dailyTrend[0]?.day;
      dataRange = { min: first, max: last };
      $('dashboardAsOf').textContent = `데이터 기간 · ${first} → ${last}`;
    } else {
      $('dashboardAsOf').textContent = '주문 데이터 없음';
    }
  }

  // ── 메인 로드 ─────────────────────────────────
  async function loadDashboard(start, end) {
    $('periodDisplay').textContent = periodLabel(start, end);
    try {
      const [summary, customers, vouchers] = await Promise.all([
        api(`/api/admin/stats/summary?start=${start}&end=${end}`),
        api(`/api/admin/stats/customers?start=${start}&end=${end}`),
        voucherCache || api('/api/admin/stats/vouchers')
      ]);
      voucherCache = vouchers;

      renderKPIs(summary.kpis);
      renderTrend(summary.dailyTrend, start, end);
      renderStatus(summary.statusDist);
      renderTopProducts(summary.topProducts);
      renderRegion(summary.region);
      renderHourly(summary.hourly);
      renderRecent(summary.recentOrders);
      renderCustomerStats(customers.summary);
      renderTopCustomers(customers.top10);
      renderNewReturning(customers.newVsReturning, start, end);
      renderVoucherStats(vouchers.byFaceValue);
      renderVoucherSummary(vouchers.summary);

      $('loading-overlay').classList.add('hidden');
    } catch (e) {
      console.error('[loadDashboard]', e);
      $('loading-overlay').innerHTML = '<div style="color:var(--danger)">오류: ' + escapeHTML(e.message) + '</div>';
    }
  }

  // ── 렌더링 ────────────────────────────────────
  function renderKPIs(k) {
    $('kpiRevenue').textContent = fmt(k.revenue);
    $('kpiOrders').textContent = fmt(k.valid_orders);
    $('kpiOrdersMeta').textContent = `전체 ${fmt(k.total_orders)}건`;
    $('kpiAOV').textContent = fmt(k.avg_order_value);
    $('kpiQty').textContent = fmt(k.quantity_sold);
    $('kpiQtyMeta').textContent = `${fmt(k.unique_products)}종 상품`;
    $('kpiCustomers').textContent = fmt(k.unique_customers);
    $('kpiCancel').textContent = fmt(k.cancelled);
    const rate = k.total_orders > 0 ? (k.cancelled / k.total_orders * 100).toFixed(1) : 0;
    $('kpiCancelMeta').textContent = `취소율 ${rate}%`;
  }

  function chartColors() {
    return {
      text: '#222', muted: '#666', border: '#e5e5e5',
      accent: '#8a6a2a', gold: '#c8a14a', danger: '#d33',
      warning: '#c2410c', success: '#28a745', info: '#2563eb'
    };
  }

  function renderTrend(rows, start, end) {
    const c = chartColors();
    const days = [];
    const cur = new Date(start); const endD = new Date(end);
    while (cur <= endD) { days.push(toISO(cur)); cur.setDate(cur.getDate() + 1); }
    const byDay = Object.fromEntries(rows.map(r => [r.day, r]));
    const orderData = days.map(d => byDay[d] ? Number(byDay[d].orders) : 0);
    const revData = days.map(d => byDay[d] ? Number(byDay[d].revenue) : 0);
    $('trendSub').textContent = `${days.length}일 · 일평균 ${fmtMoney(revData.reduce((a, b) => a + b, 0) / Math.max(days.length, 1))}원`;
    if (charts.trend) charts.trend.destroy();
    charts.trend = new Chart($('trendChart').getContext('2d'), {
      type: 'bar',
      data: {
        labels: days,
        datasets: [
          { type: 'bar', label: '매출', data: revData, backgroundColor: c.accent + 'cc', borderRadius: 4, yAxisID: 'y', order: 2 },
          { type: 'line', label: '주문수', data: orderData, borderColor: c.gold, backgroundColor: c.gold, tension: 0.3, borderWidth: 2, pointRadius: days.length > 30 ? 0 : 3, yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { color: c.text, font: { size: 11 } } },
          tooltip: { callbacks: { label: ctx => ctx.dataset.label === '매출' ? `매출: ${fmt(ctx.parsed.y)}원` : `주문: ${fmt(ctx.parsed.y)}건` } }
        },
        scales: {
          x: { grid: { color: c.border }, ticks: { color: c.muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
          y: { position: 'left', grid: { color: c.border }, ticks: { color: c.muted, font: { size: 10 }, callback: v => fmtMoney(v) }, title: { display: true, text: '매출(원)', color: c.muted, font: { size: 11 } } },
          y1: { position: 'right', grid: { display: false }, ticks: { color: c.muted, font: { size: 10 } }, title: { display: true, text: '주문(건)', color: c.muted, font: { size: 11 } } }
        }
      }
    });
  }

  function renderStatus(rows) {
    const c = chartColors();
    const colorMap = { '결제완료': c.success, '배송중': c.warning, '배송완료': c.info, '취소': c.danger, '배송준비': c.warning };
    const labels = rows.map(r => r.status_kr);
    const data = rows.map(r => Number(r.orders));
    const colors = labels.map(l => colorMap[l] || c.muted);
    if (charts.status) charts.status.destroy();
    charts.status = new Chart($('statusChart').getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmt(ctx.parsed)}건` } } } }
    });
    const total = data.reduce((a, b) => a + b, 0);
    $('statusTable').innerHTML = rows.map(r => {
      const pct = total > 0 ? (Number(r.orders) / total * 100).toFixed(1) : 0;
      return `<div class="row-flex"><span class="label">${statusBadge(r.status_kr)}</span><span class="value">${fmt(r.orders)}건 (${pct}%)</span></div>`;
    }).join('');
  }

  function renderTopProducts(rows) {
    if (!rows.length) { $('topProducts').innerHTML = '<div class="empty">데이터 없음</div>'; return; }
    const max = Math.max(...rows.map(r => Number(r.revenue)));
    $('topProducts').innerHTML = rows.map((r, i) => {
      const pct = (Number(r.revenue) / max * 100);
      const short = r.product_name.length > 22 ? r.product_name.slice(0, 22) + '…' : r.product_name;
      return `<div class="bar-row"><span class="bar-name" title="${escapeHTML(r.product_name)}">${i + 1}. ${escapeHTML(short)}</span><span class="bar-track"><span class="bar-fill ${i < 3 ? 'accent' : ''}" style="width:${pct}%"></span></span><span class="bar-val">${fmtMoney(r.revenue)}원<br><span style="font-size:10px;color:var(--text-faint)">${fmt(r.qty)}개</span></span></div>`;
    }).join('');
  }

  function renderRegion(rows) {
    if (!rows.length) { $('regionDist').innerHTML = '<div class="empty">데이터 없음</div>'; return; }
    const max = Math.max(...rows.map(r => Number(r.orders)));
    const total = rows.reduce((s, r) => s + Number(r.orders), 0);
    $('regionDist').innerHTML = rows.slice(0, 10).map(r => {
      const pct = (Number(r.orders) / max * 100);
      const sharePct = (Number(r.orders) / total * 100).toFixed(1);
      return `<div class="bar-row"><span class="bar-name">${escapeHTML(r.region)}</span><span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span><span class="bar-val">${fmt(r.orders)}건<br><span style="font-size:10px;color:var(--text-faint)">${sharePct}%</span></span></div>`;
    }).join('');
  }

  function renderHourly(rows) {
    const c = chartColors();
    const data = rows.map(r => Number(r.orders));
    const labels = Array.from({ length: 24 }, (_, h) => `${h}시`);
    if (charts.hourly) charts.hourly.destroy();
    charts.hourly = new Chart($('hourlyChart').getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: '주문수', data, backgroundColor: data.map((_, i) => (i >= 9 && i <= 18) ? c.accent + 'cc' : c.muted + '88'), borderRadius: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${ctx.parsed.y}건` } } }, scales: { x: { grid: { display: false }, ticks: { color: c.muted, font: { size: 10 } } }, y: { grid: { color: c.border }, ticks: { color: c.muted, font: { size: 10 } } } } }
    });
  }

  function renderCustomerStats(s) {
    if (!s) { $('customerStats').innerHTML = '<div class="empty">데이터 없음</div>'; return; }
    const repeatRate = s.total_customers > 0 ? (s.repeat_customers / s.total_customers * 100).toFixed(1) : 0;
    const loyalRate = s.total_customers > 0 ? (s.loyal_customers / s.total_customers * 100).toFixed(1) : 0;
    $('customerStats').innerHTML = `
      <div class="row-flex"><span class="label">기간 내 고객</span><span class="value">${fmt(s.total_customers)}명</span></div>
      <div class="row-flex"><span class="label">재구매 고객 (2회+)</span><span class="value">${fmt(s.repeat_customers)}명 (${repeatRate}%)</span></div>
      <div class="row-flex"><span class="label">충성 고객 (3회+)</span><span class="value">${fmt(s.loyal_customers)}명 (${loyalRate}%)</span></div>
      <div class="row-flex"><span class="label">평균 주문 횟수</span><span class="value">${s.avg_orders_per_customer}회</span></div>
      <div class="row-flex"><span class="label">평균 구매액</span><span class="value">${fmtMoney(s.avg_lifetime_value)}원</span></div>
      <div class="row-flex"><span class="label">최고 구매액</span><span class="value" style="color:var(--gold-dark);font-weight:700">${fmtMoney(s.top_customer_value)}원</span></div>
    `;
  }

  function renderTopCustomers(rows) {
    if (!rows.length) { $('topCustomers').innerHTML = '<div class="empty">데이터 없음</div>'; return; }
    const max = Math.max(...rows.map(r => Number(r.total_spent)));
    $('topCustomers').innerHTML = `<div class="table-scroll"><table class="dashboard-table">
      <thead><tr><th>순위</th><th>고객명</th><th class="num">주문</th><th class="num">총 구매액</th><th>첫 주문</th><th>최근 주문</th><th style="width:30%">매출 기여도</th></tr></thead>
      <tbody>${rows.map((r, i) => {
        const pct = (Number(r.total_spent) / max * 100);
        return `<tr><td><strong>#${i + 1}</strong></td><td>${escapeHTML(r.recipient)}</td><td class="num">${fmt(r.orders)}회</td><td class="num"><strong>${fmt(r.total_spent)}원</strong></td><td style="font-size:11px;color:var(--text-faint)">${r.first_order || '-'}</td><td style="font-size:11px;color:var(--text-faint)">${r.last_order || '-'}</td><td><div style="background:var(--bg-soft);height:16px;border-radius:3px;overflow:hidden"><div style="background:${i < 3 ? '#c8a14a' : '#8a6a2a'};height:100%;width:${pct}%;opacity:0.85"></div></div></td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function renderNewReturning(rows, start, end) {
    const c = chartColors();
    const days = []; const cur = new Date(start); const endD = new Date(end);
    while (cur <= endD) { days.push(toISO(cur)); cur.setDate(cur.getDate() + 1); }
    const byDay = Object.fromEntries(rows.map(r => [r.day, r]));
    const newData = days.map(d => byDay[d] ? Number(byDay[d].new_orders) : 0);
    const retData = days.map(d => byDay[d] ? Number(byDay[d].returning_orders) : 0);
    const tNew = newData.reduce((a, b) => a + b, 0);
    const tRet = retData.reduce((a, b) => a + b, 0);
    const total = tNew + tRet;
    const retPct = total > 0 ? (tRet / total * 100).toFixed(1) : 0;
    $('custSub').textContent = `재구매 비율 ${retPct}% · 신규 ${fmt(tNew)} / 재구매 ${fmt(tRet)}`;
    if (charts.nvr) charts.nvr.destroy();
    charts.nvr = new Chart($('newReturningChart').getContext('2d'), {
      type: 'bar',
      data: { labels: days, datasets: [{ label: '신규', data: newData, backgroundColor: c.gold + 'cc', borderRadius: 3, stack: 's' }, { label: '재구매', data: retData, backgroundColor: c.accent + 'cc', borderRadius: 3, stack: 's' }] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', labels: { color: c.text, font: { size: 11 } } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}건` } } }, scales: { x: { stacked: true, grid: { color: c.border }, ticks: { color: c.muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }, y: { stacked: true, grid: { color: c.border }, ticks: { color: c.muted, font: { size: 10 } } } } }
    });
  }

  function renderVoucherStats(rows) {
    $('voucherTable').innerHTML = `<thead><tr><th class="num">액면가</th><th class="num">발행</th><th class="num">사용완료</th><th class="num">부분사용</th><th class="num">미사용</th><th class="num">사용금액</th><th class="num">사용률</th></tr></thead><tbody>${rows.map(r => `<tr><td class="num">${fmt(r.face_value)}원</td><td class="num">${fmt(r.issued)}</td><td class="num">${fmt(r.used)}</td><td class="num">${fmt(r.partial)}</td><td class="num">${fmt(r.unused)}</td><td class="num">${fmtMoney(r.used_amount)}원</td><td class="num">${r.use_pct}%</td></tr>`).join('')}</tbody>`;
  }

  function renderVoucherSummary(s) {
    $('kpiVoucherCount').textContent = fmt(s.total_issued);
    $('kpiVoucherCountMeta').textContent = `평균 액면가 ${fmt(s.avg_face_value)}원`;
    $('kpiVoucherFace').textContent = fmt(s.total_face);
    $('kpiVoucherFaceMeta').innerHTML = `≈ ${fmtMoney(s.total_face)}원 · 사용 <strong>${s.use_rate}%</strong>`;
    $('voucherSummary').innerHTML = `
      <div class="row-flex"><span class="label">총 발행 수량</span><span class="value">${fmt(s.total_issued)}장</span></div>
      <div class="row-flex"><span class="label">총 발행액</span><span class="value">${fmt(s.total_face)}원</span></div>
      <div class="row-flex"><span class="label">평균 액면가</span><span class="value">${fmt(s.avg_face_value)}원</span></div>
      <div class="row-flex"><span class="label">사용 금액</span><span class="value">${fmt(s.used_amt)}원</span></div>
      <div class="row-flex"><span class="label">잔여 금액</span><span class="value">${fmt(s.remaining_amt)}원</span></div>
      <div class="row-flex"><span class="label">전체 사용률</span><span class="value" style="color:var(--gold-dark);font-weight:700">${s.use_rate}%</span></div>
      <div class="row-flex"><span class="label">완전 사용</span><span class="value">${fmt(s.fully_used)}장</span></div>
      <div class="row-flex"><span class="label">부분 사용</span><span class="value">${fmt(s.partial)}장</span></div>
      <div class="row-flex"><span class="label">미사용</span><span class="value">${fmt(s.unused)}장</span></div>
    `;
  }

  function renderRecent(rows) {
    if (!rows.length) { $('recentTable').innerHTML = '<div class="empty">기간 내 주문 없음</div>'; return; }
    $('recentTable').innerHTML = `<thead><tr><th>주문번호</th><th>주문일시</th><th>상품명</th><th class="num">수량</th><th class="num">결제금액</th><th>받는분</th><th>지역</th><th>상태</th></tr></thead><tbody>${rows.map(r => {
      const d = r.ordered_at_kst || '';
      const dStr = d ? `${d.slice(5, 10)} ${d.slice(11, 16)}` : '-';
      return `<tr><td>#${r.id}</td><td>${dStr}</td><td>${escapeHTML(r.product_name || '-')}</td><td class="num">${fmt(r.quantity)}</td><td class="num">${fmt(r.total_price)}원</td><td>${escapeHTML(r.recipient_name || '-')}</td><td>${escapeHTML((r.region || '-').replace(/특별시$|광역시$|특별자치도$|특별자치시$/, ''))}</td><td>${statusBadge(r.status_kr)}</td></tr>`;
    }).join('')}</tbody>`;
  }

  // ── 컨트롤 ────────────────────────────────────
  async function applyPreset(preset) {
    const range = presetRange(preset);
    let s, e;
    if (!range) {
      if (!dataRange.min) await loadRange();
      s = dataRange.min; e = dataRange.max;
    } else {
      s = toISO(range[0]); e = toISO(range[1]);
    }
    $('startDate').value = s; $('endDate').value = e;
    setActivePill(preset);
    await loadDashboard(s, e);
  }
  async function applyCustom() {
    const s = $('startDate').value, e = $('endDate').value;
    if (!s || !e) return;
    setActivePill(null);
    await loadDashboard(s, e);
  }

  // ── Init ─────────────────────────────────────
  document.querySelectorAll('.filter-pill[data-preset]').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
  $('applyBtn').addEventListener('click', applyCustom);
  $('startDate').addEventListener('change', () => setActivePill(null));
  $('endDate').addEventListener('change', () => setActivePill(null));

  (async () => {
    await loadRange();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
    $('startDate').value = toISO(weekStart);
    $('endDate').value = toISO(today);
    await loadDashboard(toISO(weekStart), toISO(today));
  })();
})();
