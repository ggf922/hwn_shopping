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

  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '요청 실패');
    return data.data;
  }

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
        <img src="/api/vouchers/${v.serial}/image" alt="${v.serial}" loading="lazy" />
        <div class="serial">${v.serial}</div>
        <div style="color:#666;font-size:0.85rem;margin-bottom:8px">${fmt(v.amount)}</div>
        <a href="/api/vouchers/${v.serial}/image?download=1"
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
              <a class="btn btn-secondary btn-sm" href="/api/vouchers/${v.serial}/image" target="_blank">미리보기</a>
              <a class="btn btn-success btn-sm" href="/api/vouchers/${v.serial}/image?download=1" download="${v.serial}.png">⬇ 다운로드</a>
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
    if (!confirm(`상품권 "${serial}"을(를) 삭제하시겠습니까?`)) return;
    try {
      await api(`/api/vouchers/${encodeURIComponent(serial)}`, { method: 'DELETE' });
      toast('✅ 삭제되었습니다.', 'success');
      loadVouchers();
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    }
  }

  $('#refresh-vouchers').addEventListener('click', loadVouchers);

  // ─────────────────────────────────────────
  // 제품 관리
  // ─────────────────────────────────────────
  async function loadProducts() {
    const tbody = $('#product-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">불러오는 중...</td></tr>';
    try {
      state.products = await api('/api/products');
      if (state.products.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">등록된 제품이 없습니다.</td></tr>';
        return;
      }
      tbody.innerHTML = state.products.map(p => `
        <tr>
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
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${e.message}</td></tr>`;
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
    $('#product-modal').classList.remove('hidden');
  }

  function closeProductModal() {
    $('#product-modal').classList.add('hidden');
  }

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
    if (!confirm(`"${product.name}"을(를) 삭제하시겠습니까?`)) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE' });
      toast('✅ 삭제되었습니다.', 'success');
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
  async function loadOrders() {
    const tbody = $('#order-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="loading">불러오는 중...</td></tr>';
    try {
      state.orders = await api('/api/orders');
      if (state.orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">주문 내역이 없습니다.</td></tr>';
        return;
      }
      tbody.innerHTML = state.orders.map(o => `
        <tr>
          <td>#${o.id}</td>
          <td class="serial-code">${o.voucher_serial}</td>
          <td>${escapeHtml(o.product_name)}</td>
          <td>${o.quantity}개</td>
          <td>${fmt(o.total_price)}</td>
          <td>${fmtDate(o.created_at)}</td>
        </tr>
      `).join('');
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">${e.message}</td></tr>`;
    }
  }

  $('#refresh-orders').addEventListener('click', loadOrders);
})();
