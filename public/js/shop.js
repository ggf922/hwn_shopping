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

    // 배송정보 수집
    const shipping = {
      recipient_name: $('#recipient-name').value.trim(),
      recipient_phone: $('#recipient-phone').value.trim(),
      recipient_zipcode: $('#recipient-zipcode').value.trim(),
      recipient_address: $('#recipient-address').value.trim(),
      recipient_address_detail: $('#recipient-address-detail').value.trim(),
      delivery_memo: $('#delivery-memo').value.trim()
    };

    // 필수 검증
    if (!shipping.recipient_name) return toast('받는 분 성함을 입력해주세요.', 'error');
    if (!shipping.recipient_phone) return toast('연락처를 입력해주세요.', 'error');
    if (!shipping.recipient_address) return toast('🔍 주소 검색 버튼을 눌러 주소를 선택해주세요.', 'error');

    try {
      confirmPurchaseBtn.disabled = true;
      const result = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          voucher_serial: state.voucher.serial,
          product_id: state.selectedProduct.id,
          quantity: qty,
          ...shipping
        })
      });
      state.voucher = result.voucher;
      toast(`🎉 구매 완료! 주문번호 #${result.order.id} (잔액: ${fmt(result.voucher.balance)})`, 'success');
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

  // ── 주소 검색 (다음 카카오 우편번호 API, 페이지 embed 방식) ──
  const postcodeLayer = $('#postcode-layer');
  const postcodeEmbed = $('#postcode-embed');
  const postcodeCloseBtn = $('#postcode-close-btn');

  function closeAddressSearch() {
    if (!postcodeLayer) return;
    postcodeLayer.classList.add('hidden');
    postcodeLayer.setAttribute('aria-hidden', 'true');
    if (postcodeEmbed) postcodeEmbed.innerHTML = '';
  }

  function openAddressSearch() {
    if (typeof daum === 'undefined' || !daum.Postcode) {
      toast('주소 검색 스크립트를 불러오는 중입니다. 잠시 후 다시 시도해주세요.', 'error');
      return;
    }
    if (!postcodeLayer || !postcodeEmbed) return;

    // 레이어 표시
    postcodeLayer.classList.remove('hidden');
    postcodeLayer.setAttribute('aria-hidden', 'false');
    postcodeEmbed.innerHTML = '';

    new daum.Postcode({
      oncomplete: function (data) {
        // 도로명 주소가 있으면 우선 사용, 없으면 지번 주소
        let fullAddress = data.roadAddress || data.jibunAddress;
        // 참고 항목(법정동/건물명)이 있으면 괄호로 추가
        let extra = '';
        if (data.userSelectedType === 'R') {
          if (data.bname && /[동|로|가]$/g.test(data.bname)) extra += data.bname;
          if (data.buildingName && data.apartment === 'Y') {
            extra += (extra ? ', ' : '') + data.buildingName;
          }
          if (extra) fullAddress += ` (${extra})`;
        }
        $('#recipient-zipcode').value = data.zonecode || '';
        $('#recipient-address').value = fullAddress;
        // 레이어 닫고 상세 주소 입력칸으로 포커스
        closeAddressSearch();
        const detailInput = $('#recipient-address-detail');
        if (detailInput) detailInput.focus();
      },
      onclose: function () {
        // 사용자가 검색을 닫았을 때 레이어도 함께 닫음
        closeAddressSearch();
      },
      width: '100%',
      height: '100%',
      theme: {
        bgColor: '#1a1a1a',
        searchBgColor: '#c8a14a',
        contentBgColor: '#ffffff',
        pageBgColor: '#fafafa',
        textColor: '#333333',
        queryTextColor: '#ffffff',
        postcodeTextColor: '#c8a14a',
        emphTextColor: '#c8a14a',
        outlineColor: '#c8a14a'
      }
    }).embed(postcodeEmbed);
  }

  const searchAddrBtn = $('#search-address-btn');
  if (searchAddrBtn) searchAddrBtn.addEventListener('click', openAddressSearch);
  if (postcodeCloseBtn) postcodeCloseBtn.addEventListener('click', closeAddressSearch);
  if (postcodeLayer) {
    postcodeLayer.addEventListener('click', (e) => {
      if (e.target === postcodeLayer) closeAddressSearch();
    });
  }

  // ── 초기화 ──
  loadProducts();
})();
