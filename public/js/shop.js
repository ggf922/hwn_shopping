/**
 * 하원나라 쇼핑몰 프론트엔드 로직
 */
(() => {
  'use strict';

  // ── 상태 ──
  const state = {
    products: [],
    voucher: null,         // 현재 등록된 상품권
    selectedProduct: null  // 구매 모달용
  };

  // ── DOM ──
  const $ = (sel) => document.querySelector(sel);
  const productsGrid = $('#products-grid');
  const voucherInput = $('#voucher-serial-input');
  const voucherStatus = $('#voucher-status');
  const checkVoucherBtn = $('#check-voucher-btn');
  const purchaseModal = $('#purchase-modal');
  const modalCloseBtn = $('#modal-close');
  const modalProductInfo = $('#modal-product-info');
  const purchaseQuantity = $('#purchase-quantity');
  const purchaseTotal = $('#purchase-total');
  const purchaseBalance = $('#purchase-balance');
  const confirmPurchaseBtn = $('#confirm-purchase-btn');

  // ── 유틸 ──
  const fmt = (n) => Number(n).toLocaleString('ko-KR') + '원';

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

  // ── 제품 로드 ──
  async function loadProducts() {
    try {
      state.products = await api('/api/products');
      renderProducts();
    } catch (e) {
      productsGrid.innerHTML = `<div class="empty">제품을 불러오지 못했습니다: ${e.message}</div>`;
    }
  }

  function renderProducts() {
    if (state.products.length === 0) {
      productsGrid.innerHTML = '<div class="empty">등록된 제품이 없습니다.</div>';
      return;
    }
    productsGrid.innerHTML = state.products.map(p => `
      <div class="product-card">
        <div class="product-image" style="background-image:url('${p.image_url || ''}')"></div>
        <div class="product-body">
          <div class="product-name">${escapeHtml(p.name)}</div>
          <div class="product-desc">${escapeHtml(p.description || '')}</div>
          <div class="product-meta">
            <span class="product-price">${fmt(p.price)}</span>
            <span class="product-stock">재고 ${p.stock}개</span>
          </div>
          <button class="btn btn-primary btn-sm buy-btn" data-id="${p.id}"
            ${p.stock <= 0 ? 'disabled' : ''}>
            ${p.stock <= 0 ? '품절' : '구매하기'}
          </button>
        </div>
      </div>
    `).join('');

    document.querySelectorAll('.buy-btn').forEach(btn => {
      btn.addEventListener('click', () => openPurchaseModal(Number(btn.dataset.id)));
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── 상품권 확인 ──
  async function checkVoucher() {
    const serial = voucherInput.value.trim().toUpperCase();
    if (!serial) {
      showVoucherStatus('상품권 번호를 입력해주세요.', 'error');
      return;
    }
    try {
      const voucher = await api(`/api/vouchers/${encodeURIComponent(serial)}`);
      state.voucher = voucher;
      if (voucher.status !== 'active' || voucher.balance <= 0) {
        showVoucherStatus(`이미 사용된 상품권입니다.`, 'error');
        state.voucher = null;
      } else {
        showVoucherStatus(
          `✅ 사용 가능한 상품권입니다. (액면 ${fmt(voucher.amount)} / 잔액 ${fmt(voucher.balance)})`,
          'success'
        );
      }
    } catch (e) {
      state.voucher = null;
      showVoucherStatus(`❌ ${e.message}`, 'error');
    }
  }

  function showVoucherStatus(msg, type) {
    voucherStatus.textContent = msg;
    voucherStatus.className = `voucher-status ${type}`;
  }

  // ── 구매 모달 ──
  function openPurchaseModal(productId) {
    if (!state.voucher) {
      toast('먼저 상품권 번호를 등록해주세요.', 'error');
      voucherInput.focus();
      return;
    }
    const product = state.products.find(p => p.id === productId);
    if (!product) return;
    state.selectedProduct = product;

    modalProductInfo.innerHTML = `
      <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
        <div class="product-thumb" style="width:80px;height:80px;background-image:url('${product.image_url || ''}')"></div>
        <div>
          <div style="font-weight:600;font-size:1.05rem">${escapeHtml(product.name)}</div>
          <div style="color:#888;font-size:0.9rem">단가: ${fmt(product.price)}</div>
          <div style="color:#888;font-size:0.9rem">재고: ${product.stock}개</div>
        </div>
      </div>
    `;
    purchaseQuantity.value = 1;
    purchaseQuantity.max = product.stock;
    updatePurchaseTotal();
    purchaseModal.classList.remove('hidden');
  }

  function closePurchaseModal() {
    purchaseModal.classList.add('hidden');
    state.selectedProduct = null;
  }

  function updatePurchaseTotal() {
    if (!state.selectedProduct) return;
    const qty = Math.max(1, Number(purchaseQuantity.value) || 1);
    const total = state.selectedProduct.price * qty;
    purchaseTotal.textContent = fmt(total);
    purchaseBalance.textContent = state.voucher ? fmt(state.voucher.balance) : '0원';
    confirmPurchaseBtn.disabled = !state.voucher || total > state.voucher.balance;
  }

  async function confirmPurchase() {
    if (!state.voucher || !state.selectedProduct) return;
    const qty = Math.max(1, Number(purchaseQuantity.value) || 1);
    try {
      confirmPurchaseBtn.disabled = true;
      const result = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          voucher_serial: state.voucher.serial,
          product_id: state.selectedProduct.id,
          quantity: qty
        })
      });
      state.voucher = result.voucher;
      toast(`🎉 구매가 완료되었습니다. (잔액: ${fmt(result.voucher.balance)})`, 'success');
      showVoucherStatus(
        `✅ 사용 가능한 상품권입니다. (액면 ${fmt(result.voucher.amount)} / 잔액 ${fmt(result.voucher.balance)})`,
        'success'
      );
      closePurchaseModal();
      loadProducts();
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    } finally {
      confirmPurchaseBtn.disabled = false;
    }
  }

  // ── 이벤트 ──
  checkVoucherBtn.addEventListener('click', checkVoucher);
  voucherInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') checkVoucher();
  });
  modalCloseBtn.addEventListener('click', closePurchaseModal);
  purchaseModal.addEventListener('click', (e) => {
    if (e.target === purchaseModal) closePurchaseModal();
  });
  purchaseQuantity.addEventListener('input', updatePurchaseTotal);
  confirmPurchaseBtn.addEventListener('click', confirmPurchase);

  // ── 초기화 ──
  loadProducts();
})();
