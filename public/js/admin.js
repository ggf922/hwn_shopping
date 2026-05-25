/**
 * 하원나라 관리자 페이지 로직
 */
(() => {
  'use strict';

  // ── 상수 ──
  const VOUCHER_AMOUNTS = [10000, 20000, 50000, 100000, 300000, 500000, 1000000];

  // ── 상태 ──
  const state = {
    selectedAmount: null,
    products: [],
    vouchers: [],
    orders: []
  };

  // ── DOM 헬퍼 ──
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ── 유틸 ──
  const fmt = (n) => Number(n).toLocaleString('ko-KR') + '원';
  const fmtDate = (s) => {
    if (!s) return '-';
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    return d.toLocaleString('ko-KR', { hour12: false });
  };

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  // ── 클립보드 복사 헬퍼 ──
  // 셀 내부의 줄바꿈/탭/따옴표를 안전하게 처리 (엑셀/구글 시트 호환)
  function sanitizeCell(v) {
    if (v == null) return '';
    let s = String(v).replace(/\r\n|\r|\n/g, ' ').replace(/\t/g, ' ').trim();
    // 셀 내부에 따옴표가 있으면 escape 후 전체를 따옴표로 감싸기 (엑셀 TSV 규칙)
    if (s.includes('"')) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function buildTsv(headers, rows) {
    const head = headers.join('\t');
    const body = rows.map(r => r.map(sanitizeCell).join('\t')).join('\n');
    return head + '\n' + body;
  }
  async function copyToClipboard(text) {
    // 1) Modern API
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    }
    // 2) Fallback: textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.top = '0';
      ta.style.left = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function getToken() {
    return localStorage.getItem('admin_token') || '';
  }

  function clearAuth() {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_username');
    document.cookie = 'admin_token=; path=/; max-age=0';
  }

  function redirectToLogin() {
    clearAuth();
    window.location.href = '/admin/login';
  }

  async function api(url, opts = {}) {
    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    };
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
      redirectToLogin();
      throw new Error('인증이 만료되었습니다.');
    }
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '요청 실패');
    return data.data;
  }

  // 페이지 진입 시 인증 확인
  (async () => {
    const token = getToken();
    if (!token) {
      redirectToLogin();
      return;
    }
    try {
      const res = await fetch('/api/auth/me', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!res.ok) {
        redirectToLogin();
        return;
      }
      const data = await res.json();
      const username = data.data?.username || 'admin';
      const userInfo = document.getElementById('admin-user-info');
      if (userInfo) userInfo.textContent = `👤 ${username}`;
    } catch (e) {
      redirectToLogin();
    }
  })();

  // 로그아웃
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    const token = getToken();
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token }
      });
    } catch (e) {}
    redirectToLogin();
  });

  // ─────────────────────────────────────────
  // 탭 전환
  // ─────────────────────────────────────────
  function switchTab(tab) {
    $$('.admin-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.id !== `tab-${tab}`));

    if (tab === 'voucher-list') loadVouchers();
    if (tab === 'products') loadProducts();
    if (tab === 'orders') loadOrders();
  }
  $$('.admin-tab').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // ─────────────────────────────────────────
  // 상품권 발권
  // ─────────────────────────────────────────
  function renderAmountButtons() {
    $('#amount-buttons').innerHTML = VOUCHER_AMOUNTS.map(a => `
      <button class="amount-btn" data-amount="${a}">${fmt(a)}</button>
    `).join('');
    $$('.amount-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.amount-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.selectedAmount = Number(btn.dataset.amount);
        $('#issue-btn').disabled = false;
      });
    });
  }
  renderAmountButtons();

  async function issueVouchers() {
    if (!state.selectedAmount) {
      toast('금액을 선택해주세요.', 'error');
      return;
    }
    const quantity = Math.min(100, Math.max(1, Number($('#issue-quantity').value) || 1));
    const issueBtn = $('#issue-btn');
    issueBtn.disabled = true;
    issueBtn.textContent = '발권 중...';

    try {
      const vouchers = await api('/api/vouchers', {
        method: 'POST',
        body: JSON.stringify({ amount: state.selectedAmount, quantity })
      });
      toast(`✅ ${vouchers.length}장의 상품권이 발권되었습니다.`, 'success');
      renderIssuedResult(vouchers);
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    } finally {
      issueBtn.disabled = false;
      issueBtn.textContent = '발권하기';
    }
  }

  function renderIssuedResult(vouchers) {
    const container = $('#issued-result');
    const grid = $('#voucher-result-grid');
    container.classList.remove('hidden');
    grid.innerHTML = vouchers.map(v => `
      <div class="voucher-preview">
        <img src="/api/vouchers/${v.serial}/image?t=${Date.now()}" alt="${v.serial}" loading="lazy" />
        <div class="serial">${v.serial}</div>
        <div style="color:#666;font-size:0.85rem;margin-bottom:8px">${fmt(v.amount)}</div>
        <a href="/api/vouchers/${v.serial}/image?download=1&t=${Date.now()}"
           class="btn btn-success btn-sm"
           download="${v.serial}.png">⬇ 이미지 다운로드</a>
      </div>
    `).join('');
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  $('#issue-btn').addEventListener('click', issueVouchers);

  // ─────────────────────────────────────────
  // 상품권 목록
  // ─────────────────────────────────────────
  async function loadVouchers() {
    const tbody = $('#voucher-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">불러오는 중...</td></tr>';
    try {
      state.vouchers = await api('/api/vouchers');
      if (state.vouchers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">발권된 상품권이 없습니다.</td></tr>';
        return;
      }
      tbody.innerHTML = state.vouchers.map(v => `
        <tr>
          <td class="serial-code">${v.serial}</td>
          <td>${fmt(v.amount)}</td>
          <td>${fmt(v.balance)}</td>
          <td><span class="badge ${v.status}">${v.status === 'active' ? '사용가능' : '사용완료'}</span></td>
          <td>${fmtDate(v.issued_at)}</td>
          <td>
            <div class="action-buttons">
              <a class="btn btn-secondary btn-sm" href="/api/vouchers/${v.serial}/image?t=${Date.now()}" target="_blank">미리보기</a>
              <a class="btn btn-success btn-sm" href="/api/vouchers/${v.serial}/image?download=1&t=${Date.now()}" download="${v.serial}.png">⬇ 다운로드</a>
              <button class="btn btn-danger btn-sm delete-voucher" data-serial="${v.serial}">삭제</button>
            </div>
          </td>
        </tr>
      `).join('');
      $$('.delete-voucher').forEach(btn => {
        btn.addEventListener('click', () => deleteVoucher(btn.dataset.serial));
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${e.message}</td></tr>`;
    }
  }

  async function deleteVoucher(serial) {
    if (!confirm(`상품권 "${serial}"을(를) 삭제하시겠습니까?\n\n※ 주문 이력이 있는 상품권은 목록에서 숨김 처리되며 주문 기록은 보존됩니다.`)) return;
    try {
      // 서버가 { success, mode: 'hard'|'soft', message } 형태로 응답하므로 raw fetch 사용
      const token = getToken();
      const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      };
      const r = await fetch(`/api/vouchers/${encodeURIComponent(serial)}`, { method: 'DELETE', headers });
      if (r.status === 401) { redirectToLogin(); return; }
      const json = await r.json();
      if (!json.success) throw new Error(json.error || '삭제 실패');
      const icon = json.mode === 'soft' ? '📦' : '✅';
      const message = json.message || '삭제되었습니다.';
      toast(`${icon} ${message}`, 'success');
      loadVouchers();
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    }
  }

  $('#refresh-vouchers').addEventListener('click', loadVouchers);

  // ── 상품권 목록 복사 (엑셀/구글 시트용 TSV) ──
  async function copyVouchersToClipboard() {
    if (!state.vouchers || state.vouchers.length === 0) {
      toast('복사할 상품권이 없습니다. (목록을 먼저 불러와 주세요)', 'error');
      return;
    }
    const headers = ['일련번호', '액면가', '잔액', '상태', '발권일', '사용일'];
    const rows = state.vouchers.map(v => [
      v.serial,
      Number(v.amount),
      Number(v.balance),
      v.status === 'active' ? '사용가능' : '사용완료',
      fmtDate(v.issued_at),
      v.used_at ? fmtDate(v.used_at) : ''
    ]);
    const tsv = buildTsv(headers, rows);
    const ok = await copyToClipboard(tsv);
    if (ok) {
      toast(`✅ 상품권 ${state.vouchers.length}건이 클립보드에 복사되었습니다. (엑셀/구글 시트에 붙여넣기 가능)`, 'success');
    } else {
      toast('❌ 복사에 실패했습니다. 브라우저 권한을 확인해주세요.', 'error');
    }
  }
  $('#copy-vouchers').addEventListener('click', copyVouchersToClipboard);

  // ─────────────────────────────────────────
  // 제품 관리
  // ─────────────────────────────────────────
  async function loadProducts() {
    const tbody = $('#product-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">불러오는 중...</td></tr>';
    try {
      state.products = await api('/api/products');
      if (state.products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">등록된 제품이 없습니다.</td></tr>';
        return;
      }
      const total = state.products.length;
      tbody.innerHTML = state.products.map((p, idx) => `
        <tr data-product-id="${p.id}">
          <td>
            <div class="order-controls">
              <button class="order-btn move-up" data-id="${p.id}" ${idx === 0 ? 'disabled' : ''} title="위로 이동" aria-label="위로 이동">▲</button>
              <span class="order-index">${idx + 1}</span>
              <button class="order-btn move-down" data-id="${p.id}" ${idx === total - 1 ? 'disabled' : ''} title="아래로 이동" aria-label="아래로 이동">▼</button>
            </div>
          </td>
          <td><div class="product-thumb" style="background-image:url('${escapeHtml(p.image_url || '')}')"></div></td>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td>${fmt(p.price)}</td>
          <td>${p.stock}개</td>
          <td style="max-width:300px;color:#666">${escapeHtml((p.description || '').slice(0, 60))}</td>
          <td>
            <div class="action-buttons">
              <button class="btn btn-secondary btn-sm edit-product" data-id="${p.id}">수정</button>
              <button class="btn btn-danger btn-sm delete-product" data-id="${p.id}">삭제</button>
            </div>
          </td>
        </tr>
      `).join('');
      $$('.edit-product').forEach(b => b.addEventListener('click', () => openProductModal(Number(b.dataset.id))));
      $$('.delete-product').forEach(b => b.addEventListener('click', () => deleteProduct(Number(b.dataset.id))));
      $$('.move-up').forEach(b => b.addEventListener('click', () => moveProduct(Number(b.dataset.id), 'up')));
      $$('.move-down').forEach(b => b.addEventListener('click', () => moveProduct(Number(b.dataset.id), 'down')));
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${e.message}</td></tr>`;
    }
  }

  async function moveProduct(id, direction) {
    // 연속 클릭 방지 — 버튼 일시 비활성화
    $$('.move-up, .move-down').forEach(b => (b.disabled = true));
    try {
      const result = await api(`/api/products/${id}/move`, {
        method: 'POST',
        body: JSON.stringify({ direction })
      });
      if (result && result.moved === false) {
        toast(result.message || '이동할 수 없습니다.', 'info');
      }
      await loadProducts();
    } catch (e) {
      toast('순서 변경 실패: ' + e.message, 'error');
      // 실패 시 버튼 재활성화
      await loadProducts();
    }
  }

  function openProductModal(id = null) {
    const product = id != null ? state.products.find(p => p.id === id) : null;
    $('#product-modal-title').textContent = product ? '제품 수정' : '제품 등록';
    $('#product-id').value = product ? product.id : '';
    $('#product-name').value = product ? product.name : '';
    $('#product-price').value = product ? product.price : '';
    $('#product-stock').value = product ? product.stock : 0;
    $('#product-image').value = product ? (product.image_url || '') : '';
    $('#product-description').value = product ? (product.description || '') : '';
    updateImagePreview(product ? product.image_url : '');
    $('#product-image-file').value = '';
    $('#product-modal').classList.remove('hidden');
  }

  function closeProductModal() {
    $('#product-modal').classList.add('hidden');
  }

  // ── 이미지 미리보기 ──
  function updateImagePreview(url) {
    const preview = $('#image-preview');
    const removeBtn = $('#remove-image-btn');
    if (url && url.trim()) {
      preview.innerHTML = `<img src="${escapeHtml(url)}" alt="미리보기" />`;
      removeBtn.classList.remove('hidden');
    } else {
      preview.innerHTML = '<span class="image-placeholder">이미지를 업로드하거나 URL을 입력하세요</span>';
      removeBtn.classList.add('hidden');
    }
  }

  // ── 이미지 업로드 ──
  $('#upload-image-btn').addEventListener('click', () => $('#product-image-file').click());

  $('#product-image-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('파일 크기가 5MB를 초과합니다.', 'error');
      return;
    }
    const fd = new FormData();
    fd.append('image', file);
    const uploadBtn = $('#upload-image-btn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = '⏳ 업로드 중...';
    try {
      const token = getToken();
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: fd,
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      const json = await res.json();
      if (!json.success) throw new Error(json.error || '업로드 실패');
      $('#product-image').value = json.data.url;
      updateImagePreview(json.data.url);
      toast('✅ 이미지 업로드 완료', 'success');
    } catch (err) {
      toast(`❌ ${err.message}`, 'error');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📁 이미지 파일 업로드';
    }
  });

  $('#remove-image-btn').addEventListener('click', () => {
    $('#product-image').value = '';
    $('#product-image-file').value = '';
    updateImagePreview('');
  });

  // URL 직접 입력 시 미리보기 업데이트
  $('#product-image').addEventListener('input', (e) => updateImagePreview(e.target.value));

  async function saveProduct() {
    const id = $('#product-id').value;
    const payload = {
      name: $('#product-name').value.trim(),
      price: Number($('#product-price').value),
      stock: Number($('#product-stock').value) || 0,
      image_url: $('#product-image').value.trim(),
      description: $('#product-description').value.trim()
    };
    if (!payload.name) {
      toast('제품명을 입력해주세요.', 'error');
      return;
    }
    if (!payload.price || payload.price <= 0) {
      toast('가격을 올바르게 입력해주세요.', 'error');
      return;
    }
    try {
      if (id) {
        await api(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        toast('✅ 제품이 수정되었습니다.', 'success');
      } else {
        await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
        toast('✅ 제품이 등록되었습니다.', 'success');
      }
      closeProductModal();
      loadProducts();
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    }
  }

  async function deleteProduct(id) {
    const product = state.products.find(p => p.id === id);
    if (!product) return;
    if (!confirm(`"${product.name}"을(를) 삭제하시겠습니까?\n\n※ 주문 이력이 있는 제품은 목록에서 숨김 처리되며 주문 기록은 보존됩니다.`)) return;
    try {
      const res = await api(`/api/products/${id}`, { method: 'DELETE' });
      // 서버가 { success, mode: 'hard'|'soft', message } 반환
      const message = res?.message || '삭제되었습니다.';
      const icon = res?.mode === 'soft' ? '📦' : '✅';
      toast(`${icon} ${message}`, 'success');
      loadProducts();
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    }
  }

  $('#add-product-btn').addEventListener('click', () => openProductModal());
  $('#product-modal-close').addEventListener('click', closeProductModal);
  $('#product-modal').addEventListener('click', (e) => {
    if (e.target === $('#product-modal')) closeProductModal();
  });
  $('#save-product-btn').addEventListener('click', saveProduct);

  // ─────────────────────────────────────────
  // 주문 내역
  // ─────────────────────────────────────────
  const ORDER_STATUS_LABEL = {
    pending: { label: '결제완료', class: 'pending' },
    preparing: { label: '배송준비', class: 'preparing' },
    shipped: { label: '배송중', class: 'shipped' },
    delivered: { label: '배송완료', class: 'delivered' },
    cancelled: { label: '취소', class: 'cancelled' }
  };

  function statusBadge(status) {
    const s = ORDER_STATUS_LABEL[status] || ORDER_STATUS_LABEL.pending;
    return `<span class="badge status-${s.class}">${s.label}</span>`;
  }

  async function loadOrders() {
    const tbody = $('#order-tbody');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">불러오는 중...</td></tr>';
    try {
      state.orders = await api('/api/orders');
      if (state.orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty">주문 내역이 없습니다.</td></tr>';
        return;
      }
      tbody.innerHTML = state.orders.map(o => `
        <tr class="order-row" data-id="${o.id}" style="cursor:pointer">
          <td>
            <strong>#${o.id}</strong><br>
            <span class="serial-code" style="font-size:0.75rem">${o.voucher_serial}</span>
          </td>
          <td>
            ${escapeHtml(o.product_name)} × ${o.quantity}<br>
            <span style="color:var(--gold-dark);font-weight:600">${fmt(o.total_price)}</span>
          </td>
          <td>${escapeHtml(o.recipient_name || '-')}</td>
          <td>${escapeHtml(o.recipient_phone || '-')}</td>
          <td style="max-width:260px">
            ${o.recipient_zipcode ? `<small style="color:#888">[${escapeHtml(o.recipient_zipcode)}]</small> ` : ''}
            ${escapeHtml(o.recipient_address || '-')}
            ${o.recipient_address_detail ? `<br><small style="color:#666">${escapeHtml(o.recipient_address_detail)}</small>` : ''}
          </td>
          <td style="max-width:160px;color:#666;font-size:0.85rem">${escapeHtml(o.delivery_memo || '-')}</td>
          <td>${statusBadge(o.status || 'pending')}</td>
          <td style="font-size:0.85rem">${fmtDate(o.created_at)}</td>
        </tr>
      `).join('');
      $$('.order-row').forEach(row => {
        row.addEventListener('click', () => openOrderDetail(Number(row.dataset.id)));
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${e.message}</td></tr>`;
    }
  }

  function openOrderDetail(orderId) {
    const o = state.orders.find(x => x.id === orderId);
    if (!o) return;
    const statuses = ['pending', 'preparing', 'shipped', 'delivered', 'cancelled'];
    const currentStatus = o.status || 'pending';
    $('#order-detail-body').innerHTML = `
      <div class="detail-section">
        <h4>주문 정보</h4>
        <div class="detail-row"><span>주문번호</span><strong>#${o.id}</strong></div>
        <div class="detail-row"><span>상품권</span><span class="serial-code">${o.voucher_serial}</span></div>
        <div class="detail-row"><span>제품</span><strong>${escapeHtml(o.product_name)} × ${o.quantity}</strong></div>
        <div class="detail-row"><span>결제금액</span><strong style="color:var(--gold-dark)">${fmt(o.total_price)}</strong></div>
        <div class="detail-row"><span>주문일시</span>${fmtDate(o.created_at)}</div>
      </div>
      <div class="detail-section">
        <h4>📦 배송 정보</h4>
        <div class="detail-row"><span>받는 분</span><strong>${escapeHtml(o.recipient_name || '-')}</strong></div>
        <div class="detail-row"><span>연락처</span>${escapeHtml(o.recipient_phone || '-')}</div>
        <div class="detail-row"><span>우편번호</span>${escapeHtml(o.recipient_zipcode || '-')}</div>
        <div class="detail-row"><span>주소</span>${escapeHtml(o.recipient_address || '-')}</div>
        <div class="detail-row"><span>상세주소</span>${escapeHtml(o.recipient_address_detail || '-')}</div>
        <div class="detail-row"><span>배송메모</span>${escapeHtml(o.delivery_memo || '-')}</div>
      </div>
      <div class="detail-section">
        <h4>주문 상태 변경</h4>
        <select id="order-status-select">
          ${statuses.map(s => `<option value="${s}" ${s===currentStatus?'selected':''}>${ORDER_STATUS_LABEL[s].label}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" id="save-order-status" style="margin-left:8px" data-id="${o.id}">상태 저장</button>
      </div>
    `;
    $('#save-order-status').addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      const status = $('#order-status-select').value;
      try {
        await api(`/api/orders/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
        toast('✅ 주문 상태가 변경되었습니다.', 'success');
        closeOrderDetail();
        loadOrders();
      } catch (err) {
        toast(`❌ ${err.message}`, 'error');
      }
    });
    $('#order-detail-modal').classList.remove('hidden');
  }

  function closeOrderDetail() {
    $('#order-detail-modal').classList.add('hidden');
  }

  $('#order-detail-close').addEventListener('click', closeOrderDetail);
  $('#order-detail-modal').addEventListener('click', (e) => {
    if (e.target === $('#order-detail-modal')) closeOrderDetail();
  });

  $('#refresh-orders').addEventListener('click', loadOrders);

  // ── 주문 내역 복사 (엑셀/구글 시트용 TSV) ──
  async function copyOrdersToClipboard() {
    if (!state.orders || state.orders.length === 0) {
      toast('복사할 주문이 없습니다. (목록을 먼저 불러와 주세요)', 'error');
      return;
    }
    const statusMap = {
      pending: '결제완료',
      preparing: '상품준비중',
      shipped: '배송중',
      delivered: '배송완료',
      cancelled: '취소'
    };
    const headers = [
      '주문번호', '상품권일련번호', '상품명', '수량', '결제금액',
      '받는분', '연락처', '우편번호', '주소', '상세주소', '배송메모', '상태', '주문일시'
    ];
    const rows = state.orders.map(o => [
      '#' + o.id,
      o.voucher_serial || '',
      o.product_name || '',
      Number(o.quantity || 0),
      Number(o.total_price || 0),
      o.recipient_name || '',
      o.recipient_phone || '',
      o.recipient_zipcode || '',
      o.recipient_address || '',
      o.recipient_address_detail || '',
      o.delivery_memo || '',
      statusMap[o.status] || o.status || '결제완료',
      fmtDate(o.created_at)
    ]);
    const tsv = buildTsv(headers, rows);
    const ok = await copyToClipboard(tsv);
    if (ok) {
      toast(`✅ 주문 ${state.orders.length}건이 클립보드에 복사되었습니다. (엑셀/구글 시트에 붙여넣기 가능)`, 'success');
    } else {
      toast('❌ 복사에 실패했습니다. 브라우저 권한을 확인해주세요.', 'error');
    }
  }
  $('#copy-orders').addEventListener('click', copyOrdersToClipboard);
})();
