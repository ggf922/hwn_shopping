// 하원나라 발주서 생성 페이지 (/admin/po)
(function () {
  'use strict';

  // ── 인증 ──────────────────────────────────────
  function getToken() { return localStorage.getItem('admin_token') || ''; }
  function redirectToLogin() {
    localStorage.removeItem('admin_token');
    window.location.href = '/admin/login';
  }
  async function api(url, opts = {}) {
    const token = getToken();
    if (!token) return redirectToLogin();
    const res = await fetch(url, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
        Authorization: 'Bearer ' + token
      }
    });
    if (res.status === 401) return redirectToLogin();
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '요청 실패');
    return data.data;
  }

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

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + getToken() } }); } catch {}
    redirectToLogin();
  });

  // ── 유틸 ──────────────────────────────────────
  const $ = id => document.getElementById(id);
  const fmt = n => (Number(n) || 0).toLocaleString('ko-KR');
  function pad(n) { return String(n).padStart(2, '0'); }
  function toISO(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function escapeHTML(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function normalizePhone(p) {
    if (!p) return '';
    let s = String(p).replace(/[^0-9]/g, '');
    if (s.startsWith('0')) {
      if (s.length === 11) return s.slice(0, 3) + '-' + s.slice(3, 7) + '-' + s.slice(7);
      if (s.length === 10) return s.slice(0, 3) + '-' + s.slice(3, 6) + '-' + s.slice(6);
    }
    return p;
  }

  let groups = [];
  let suppliers = [];

  // ── 기간 ──────────────────────────────────────
  function presetRange(preset) {
    const now = new Date();
    const today8 = new Date(now); today8.setHours(8, 0, 0, 0);
    const y8 = new Date(today8); y8.setDate(y8.getDate() - 1);
    const db8 = new Date(today8); db8.setDate(db8.getDate() - 2);
    const tmr8 = new Date(today8); tmr8.setDate(tmr8.getDate() + 1);
    const fmtTs = d => `${toISO(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    switch (preset) {
      case 'today_8am': return [fmtTs(today8), fmtTs(tmr8), '오늘'];
      case 'yesterday_8am': return [fmtTs(y8), fmtTs(today8), '어제'];
      case 'day_before': return [fmtTs(db8), fmtTs(y8), '그제'];
    }
  }
  function customRange() {
    const d = $('customDate').value;
    if (!d) return null;
    const start = `${d} 08:00:00`;
    const next = new Date(d + 'T00:00:00');
    next.setDate(next.getDate() + 1);
    const end = `${toISO(next)} 08:00:00`;
    return [start, end, d];
  }
  function setActivePill(preset) {
    document.querySelectorAll('.filter-pill[data-preset]').forEach(p => p.classList.remove('active'));
    if (preset) document.querySelector(`.filter-pill[data-preset="${preset}"]`)?.classList.add('active');
  }

  // ── 로드 + 렌더링 ─────────────────────────────
  async function loadGroups(startTs, endTs, label) {
    $('periodLabel').textContent = `${startTs} ~ ${endTs}` + (label ? ` (${label})` : '');
    $('content').innerHTML = '<div class="dashboard-loading" style="position:static;background:transparent"><div class="dashboard-spinner"></div><span>주문 불러오는 중...</span></div>';
    try {
      const d = await api(`/api/admin/po/orders?start=${encodeURIComponent(startTs)}&end=${encodeURIComponent(endTs)}`);
      groups = d.groups || [];
      renderGroups();
    } catch (e) {
      console.error(e);
      $('content').innerHTML = `<div class="no-orders">오류: ${escapeHTML(e.message)}</div>`;
    }
  }

  function renderGroups() {
    if (groups.length === 0) {
      $('content').innerHTML = `<div class="no-orders">📭 해당 기간에 주문이 없습니다.</div>`;
      return;
    }
    const html = groups.map((g, gi) => {
      const byProduct = new Map();
      let totalQty = 0;
      for (const o of g.orders) {
        const k = o.product_name;
        byProduct.set(k, (byProduct.get(k) || 0) + (Number(o.quantity) || 0));
        totalQty += (Number(o.quantity) || 0);
      }
      const products = Array.from(byProduct.entries()).sort((a, b) => b[1] - a[1]);
      const productLines = products.map(([name, qty]) => `<div class="product-line"><span class="pname">${escapeHTML(name)}</span><span class="pqty">${fmt(qty)}개</span></div>`).join('');
      return `<div class="supplier-card">
        <div class="supplier-card-header">
          <div class="supplier-name">${escapeHTML(g.supplier_name)}</div>
          <span class="format-tag">${g.format_type === 'nangman' ? '낭만식' : '표준식'}</span>
        </div>
        <div class="supplier-summary">
          <div class="sup-stat"><div class="sup-stat-label">주문 행수</div><div class="sup-stat-value">${fmt(g.orders.length)}</div></div>
          <div class="sup-stat"><div class="sup-stat-label">총 수량</div><div class="sup-stat-value">${fmt(totalQty)}</div></div>
          <div class="sup-stat"><div class="sup-stat-label">상품 종류</div><div class="sup-stat-value">${fmt(products.length)}</div></div>
        </div>
        <div class="product-summary">${productLines}</div>
        <div class="supplier-actions">
          <button class="btn btn-primary btn-sm" data-action="preview" data-gi="${gi}">👁 미리보기 & 복사</button>
          <button class="btn btn-secondary btn-sm" data-action="download" data-gi="${gi}">⬇ XLSX</button>
        </div>
      </div>`;
    }).join('');
    $('content').innerHTML = `<div class="supplier-grid">${html}</div>`;
    $('content').querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const gi = Number(btn.dataset.gi);
        if (btn.dataset.action === 'preview') openPreview(gi);
        else downloadXlsx(gi);
      });
    });
  }

  // ── PO 서식 ──────────────────────────────────
  function buildStandardRows(orders) {
    const sorted = [...orders].sort((a, b) => {
      const c = (a.product_name || '').localeCompare(b.product_name || '');
      if (c !== 0) return c;
      return (a.recipient || '').localeCompare(b.recipient || '');
    });
    const rows = [['상품명', '수량', '받는분', '연락처', '우편번호', '주소', '메모']];
    for (const o of sorted) {
      const addr = o.address_detail ? `${o.address || ''} ${o.address_detail}`.trim() : (o.address || '');
      rows.push([o.product_name || '', Number(o.quantity) || 0, o.recipient || '', normalizePhone(o.phone), o.postal_code || '', addr, o.delivery_memo || '']);
    }
    return rows;
  }
  function buildNangmanRows(orders) {
    const sorted = [...orders].sort((a, b) => {
      const c = (a.product_name || '').localeCompare(b.product_name || '');
      if (c !== 0) return c;
      return (a.recipient || '').localeCompare(b.recipient || '');
    });
    const headers = ['주문번호', '받는사람', '전화번호1', '전화번호2', '우편번호', '주소', '상품명1', '상품상세1', '수량(A타입)', '배송메시지', '운임구분', '운임'];
    const rows = [headers];
    sorted.forEach((o, idx) => {
      const addr = o.address_detail ? `${o.address || ''} ${o.address_detail}`.trim() : (o.address || '');
      rows.push([idx + 1, o.recipient || '', ' ' + (normalizePhone(o.phone) || ''), '', o.postal_code || '', addr, o.product_name || '', '', Number(o.quantity) || 0, o.delivery_memo || '', '', '']);
    });
    return rows;
  }
  function buildRows(g) { return g.format_type === 'nangman' ? buildNangmanRows(g.orders) : buildStandardRows(g.orders); }
  function rowsToHTML(rows) {
    return `<table class="po-table"><thead><tr>${rows[0].map(h => `<th>${escapeHTML(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(1).map(r => `<tr>${r.map(c => `<td class="${typeof c === 'number' ? 'num' : ''}">${escapeHTML(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  function rowsToTSV(rows) { return rows.map(r => r.map(c => String(c ?? '').replace(/[\t\n\r]/g, ' ')).join('\t')).join('\n'); }

  function openPreview(gi) {
    const g = groups[gi];
    const rows = buildRows(g);
    const period = $('periodLabel').textContent;
    $('poModalTitle').textContent = `${g.supplier_name} 발주서 (${period})`;
    $('poTableContainer').innerHTML = rowsToHTML(rows);
    $('poModal').classList.add('show');
    $('poModal').dataset.gi = gi;
    $('copyStatus').classList.remove('show');
  }
  function downloadXlsx(gi) {
    const g = groups[gi];
    const rows = buildRows(g);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const colWidths = [];
    for (const r of rows) r.forEach((c, ci) => { const l = String(c ?? '').length; if (!colWidths[ci] || l > colWidths[ci]) colWidths[ci] = l; });
    ws['!cols'] = colWidths.map(w => ({ wch: Math.min(Math.max(w + 2, 8), 50) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const today = new Date();
    const dateStr = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;
    XLSX.writeFile(wb, `${g.supplier_name} 발주서 ${dateStr}.xlsx`);
  }
  async function downloadAll() {
    if (groups.length === 0) { alert('주문이 없습니다.'); return; }
    for (let i = 0; i < groups.length; i++) { downloadXlsx(i); await new Promise(r => setTimeout(r, 300)); }
  }
  async function copyTable() {
    const gi = Number($('poModal').dataset.gi);
    const rows = buildRows(groups[gi]);
    const html = rowsToHTML(rows);
    const tsv = rowsToTSV(rows);
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([tsv], { type: 'text/plain' }) })]);
      } else { await navigator.clipboard.writeText(tsv); }
      showStatus('✅ 표 복사 완료! Excel/구글시트에 바로 붙여넣을 수 있습니다.');
    } catch (e) {
      const ta = document.createElement('textarea'); ta.value = tsv; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      showStatus('✅ 텍스트로 복사되었습니다.');
    }
  }
  async function copyText() {
    const gi = Number($('poModal').dataset.gi);
    const tsv = rowsToTSV(buildRows(groups[gi]));
    try { await navigator.clipboard.writeText(tsv); showStatus('✅ 텍스트(TSV) 복사 완료!'); }
    catch (e) { showStatus('❌ 복사 실패: ' + e.message); }
  }
  function showStatus(msg) {
    const s = $('copyStatus'); s.textContent = msg; s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 3000);
  }

  // ── 설정 ─────────────────────────────────────
  async function openSettings() {
    const [supList, prodList] = await Promise.all([
      api('/api/admin/suppliers'),
      api('/api/admin/products-supplier')
    ]);
    suppliers = supList;
    const supOpts = (id) => suppliers.map(s => `<option value="${s.id}" ${id == s.id ? 'selected' : ''}>${escapeHTML(s.name)}</option>`).join('');
    $('settingsList').innerHTML = prodList.map(p => `<div class="settings-row" data-pid="${p.id}"><div class="name">${escapeHTML(p.name)}</div><select data-pid="${p.id}"><option value="">— 미지정 —</option>${supOpts(p.supplier_id)}</select><div style="font-size:11px;color:var(--text-faint);text-align:right;font-family:ui-monospace,monospace">${fmt(p.price)}원</div></div>`).join('');
    $('settingsList').querySelectorAll('select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        try {
          await api('/api/admin/products-supplier', { method: 'PUT', body: JSON.stringify({ product_id: e.target.dataset.pid, supplier_id: e.target.value || null }) });
          sel.style.borderColor = 'var(--success)';
          setTimeout(() => sel.style.borderColor = '', 1000);
        } catch (err) { sel.style.borderColor = 'var(--danger)'; }
      });
    });
    $('settingsModal').classList.add('show');
  }
  async function addSupplier() {
    const name = $('newSupplierName').value.trim();
    const ft = $('newSupplierFormat').value;
    if (!name) { alert('공급사 이름을 입력하세요.'); return; }
    try {
      await api('/api/admin/suppliers', { method: 'POST', body: JSON.stringify({ name, format_type: ft }) });
      $('newSupplierName').value = '';
      await openSettings();
    } catch (e) { alert('추가 실패: ' + e.message); }
  }

  // ── Init ─────────────────────────────────────
  document.querySelectorAll('.filter-pill[data-preset]').forEach(btn => {
    btn.addEventListener('click', async () => {
      setActivePill(btn.dataset.preset);
      const [s, e, label] = presetRange(btn.dataset.preset);
      await loadGroups(s, e, label);
    });
  });
  $('applyCustomBtn').addEventListener('click', async () => {
    setActivePill(null);
    const r = customRange();
    if (r) await loadGroups(r[0], r[1], r[2] + ' 사용자 지정');
  });
  $('modalCloseBtn').addEventListener('click', () => $('poModal').classList.remove('show'));
  $('settingsCloseBtn').addEventListener('click', () => $('settingsModal').classList.remove('show'));
  [$('poModal'), $('settingsModal')].forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
  $('copyTableBtn').addEventListener('click', copyTable);
  $('copyTextBtn').addEventListener('click', copyText);
  $('downloadXlsxBtn').addEventListener('click', () => downloadXlsx(Number($('poModal').dataset.gi)));
  $('settingsBtn').addEventListener('click', openSettings);
  $('addSupplierBtn').addEventListener('click', addSupplier);
  $('downloadAllBtn').addEventListener('click', downloadAll);

  $('customDate').value = toISO(new Date());

  (async () => {
    const [s, e, label] = presetRange('yesterday_8am');
    await loadGroups(s, e, label);
  })();
})();
