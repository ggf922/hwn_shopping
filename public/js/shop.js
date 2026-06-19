/**
 * 하원나라 쇼핑몰 프론트엔드 로직 (다중 상품권 결제 지원)
 */
(() => {
  'use strict';

  // ── 상태 ──
  const state = {
    products: [],
    vouchers: [],          // 등록된 상품권 배열 (FIFO 결제 순서)
    selectedProduct: null  // 구매 모달용
  };

  // ── DOM ──
  const $ = (sel) => document.querySelector(sel);
  const productsGrid = $('#products-grid');
  const voucherInput = $('#voucher-serial-input');
  const voucherStatus = $('#voucher-status');
  const checkVoucherBtn = $('#check-voucher-btn');
  const voucherListWrap = $('#voucher-list-wrap');
  const voucherListEl = $('#voucher-list');
  const voucherTotalBalanceEl = $('#voucher-total-balance');
  const purchaseModal = $('#purchase-modal');
  const modalCloseBtn = $('#modal-close');
  const modalProductInfo = $('#modal-product-info');
  const purchaseQuantity = $('#purchase-quantity');
  const purchaseTotal = $('#purchase-total');
  const purchaseBalance = $('#purchase-balance');
  const purchaseUsagePreview = $('#purchase-usage-preview');
  const purchaseUsageList = $('#purchase-usage-list');
  const confirmPurchaseBtn = $('#confirm-purchase-btn');

  // ── 유틸 ──
  const fmt = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';

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

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  // ── 상품권 등록 (다중) ──
  // 합계 잔액: 같은 시리얼이 어떤 이유로 중복 등록되더라도
  // 잔액이 부풀려지지 않도록 시리얼 기준으로 unique 합산한다.
  function getTotalBalance() {
    const seen = new Set();
    let sum = 0;
    for (const v of state.vouchers) {
      const key = String(v.serial || '').toUpperCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      sum += (v.balance || 0);
    }
    return sum;
  }

  // state.vouchers 에서 시리얼 중복을 제거한 사본을 반환
  // (어떤 경로로든 중복이 들어왔을 경우의 방어막)
  function getUniqueVouchers() {
    const seen = new Set();
    const out = [];
    for (const v of state.vouchers) {
      const key = String(v.serial || '').toUpperCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  // 상품권 시리얼 정규화
  // - 사용자가 뒷부분(예: "CU88538")만 입력 → "HWN-2026-CU88538"로 자동 보정
  // - 사용자가 전체("HWN-2026-CU88538") 입력 → 그대로 사용
  // - 소문자/공백/하이픈 누락 등도 관용적으로 처리
  function normalizeSerial(raw) {
    const VOUCHER_PREFIX = 'HWN-2026-';
    if (!raw) return '';
    // 공백 제거 + 대문자화
    let s = String(raw).replace(/\s+/g, '').toUpperCase();
    // 이미 풀 시리얼이면 그대로
    if (s.startsWith(VOUCHER_PREFIX)) return s;
    // "HWN2026CU88538" 처럼 하이픈만 빠진 경우 보정
    const noHyphen = s.replace(/-/g, '');
    if (noHyphen.startsWith('HWN2026') && noHyphen.length >= 7) {
      const suffix = noHyphen.slice(7); // "HWN2026" 이후
      return VOUCHER_PREFIX + suffix;
    }
    // 그 외(접미사만 입력) → prefix 결합
    // 사용자가 실수로 "-CU88538" 같이 입력한 경우 앞 하이픈 제거
    s = s.replace(/^-+/, '');
    return VOUCHER_PREFIX + s;
  }

  async function addVoucher() {
    const serial = normalizeSerial(voucherInput.value);
    if (!serial || serial === 'HWN-2026-') {
      showVoucherStatus('상품권 번호를 입력해주세요. (예: AF93875)', 'error');
      return;
    }
    // 중복 등록 방지 (대소문자/공백 무시한 정규화 비교)
    const serialKey = String(serial).toUpperCase().trim();
    if (state.vouchers.some(v => String(v.serial || '').toUpperCase().trim() === serialKey)) {
      showVoucherStatus(`이미 등록된 상품권입니다: ${serial}`, 'error');
      return;
    }
    try {
      const voucher = await api(`/api/vouchers/${encodeURIComponent(serial)}`);
      if (voucher.status !== 'active' || voucher.balance <= 0) {
        showVoucherStatus(`이미 사용된 상품권입니다.`, 'error');
        return;
      }
      if (voucher.is_deleted) {
        showVoucherStatus(`사용할 수 없는 상품권입니다.`, 'error');
        return;
      }
      // 서버 응답의 serial 로 한 번 더 중복 체크 (race condition 방어)
      const respSerialKey = String(voucher.serial || '').toUpperCase().trim();
      if (respSerialKey && state.vouchers.some(v => String(v.serial || '').toUpperCase().trim() === respSerialKey)) {
        showVoucherStatus(`이미 등록된 상품권입니다: ${voucher.serial}`, 'error');
        return;
      }
      state.vouchers.push(voucher);
      voucherInput.value = '';
      renderVoucherList();
      showVoucherStatus(
        `✅ 상품권이 추가되었습니다. (잔액 ${fmt(voucher.balance)}) — 합계 잔액 ${fmt(getTotalBalance())}`,
        'success'
      );
    } catch (e) {
      showVoucherStatus(`❌ ${e.message}`, 'error');
    }
  }

  function removeVoucher(serial) {
    state.vouchers = state.vouchers.filter(v => v.serial !== serial);
    renderVoucherList();
    if (state.vouchers.length === 0) {
      showVoucherStatus('등록된 상품권이 없습니다. 상품권 번호를 입력해 추가해 주세요.', 'info');
    } else {
      showVoucherStatus(`상품권을 제거했습니다. 합계 잔액 ${fmt(getTotalBalance())}`, 'info');
    }
  }

  function renderVoucherList() {
    // 시리얼 기준 중복 제거 후 표시 (방어막)
    const uniq = getUniqueVouchers();
    if (uniq.length !== state.vouchers.length) {
      // state 가 중복을 머금고 있으면 정리
      state.vouchers = uniq;
    }
    if (state.vouchers.length === 0) {
      voucherListWrap.classList.add('hidden');
      voucherListEl.innerHTML = '';
      voucherTotalBalanceEl.textContent = '0원';
      return;
    }
    voucherListWrap.classList.remove('hidden');
    voucherListEl.innerHTML = state.vouchers.map((v, i) => `
      <li class="voucher-item" data-serial="${escapeHtml(v.serial)}">
        <span class="voucher-order">${i + 1}</span>
        <span class="voucher-serial-text">${escapeHtml(v.serial)}</span>
        <span class="voucher-balance-text">잔액 ${fmt(v.balance)}</span>
        <button type="button" class="voucher-remove-btn" data-serial="${escapeHtml(v.serial)}" aria-label="제거">✕</button>
      </li>
    `).join('');
    voucherTotalBalanceEl.textContent = fmt(getTotalBalance());

    voucherListEl.querySelectorAll('.voucher-remove-btn').forEach(btn => {
      btn.addEventListener('click', () => removeVoucher(btn.dataset.serial));
    });
  }

  function showVoucherStatus(msg, type) {
    voucherStatus.textContent = msg;
    voucherStatus.className = `voucher-status ${type}`;
  }

  // FIFO 사용 시뮬레이션 (구매 모달에서 미리보기로 표시)
  function simulateUsage(totalPrice) {
    const usages = [];
    let remaining = totalPrice;
    for (let i = 0; i < state.vouchers.length && remaining > 0; i++) {
      const v = state.vouchers[i];
      const take = Math.min(remaining, v.balance);
      if (take <= 0) continue;
      usages.push({
        sequence: usages.length + 1,
        serial: v.serial,
        balance_before: v.balance,
        amount_used: take,
        balance_after: v.balance - take
      });
      remaining -= take;
    }
    return { usages, shortfall: remaining };
  }

  // ── 구매 모달 ──
  function openPurchaseModal(productId) {
    if (state.vouchers.length === 0) {
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
    // 모달을 열 때마다 개인정보 동의는 초기화 (체크 해제)
    const privacyAgreeEl = $('#privacy-agree');
    if (privacyAgreeEl) privacyAgreeEl.checked = false;
    const privacyDetailsEl = $('#privacy-details');
    const privacyToggleEl = $('#privacy-toggle-btn');
    if (privacyDetailsEl && !privacyDetailsEl.classList.contains('hidden')) {
      privacyDetailsEl.classList.add('hidden');
      if (privacyToggleEl) {
        privacyToggleEl.setAttribute('aria-expanded', 'false');
        privacyToggleEl.textContent = '자세히 보기 ▼';
      }
    }
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
    const totalBalance = getTotalBalance();
    purchaseTotal.textContent = fmt(total);
    purchaseBalance.textContent = fmt(totalBalance);

    const { usages, shortfall } = simulateUsage(total);
    if (state.vouchers.length > 0 && total > 0) {
      purchaseUsagePreview.classList.remove('hidden');
      if (shortfall > 0) {
        purchaseUsageList.innerHTML = `
          <li class="usage-shortfall">상품권 잔액이 ${fmt(shortfall)} 부족합니다. 상품권을 추가로 등록해 주세요.</li>
        `;
      } else {
        purchaseUsageList.innerHTML = usages.map(u => `
          <li>
            <span class="usage-seq">${u.sequence}.</span>
            <span class="usage-serial">${escapeHtml(u.serial)}</span>
            <span class="usage-amount">−${fmt(u.amount_used)}</span>
            <span class="usage-after">(잔액 ${fmt(u.balance_after)})</span>
          </li>
        `).join('');
      }
    } else {
      purchaseUsagePreview.classList.add('hidden');
      purchaseUsageList.innerHTML = '';
    }

    confirmPurchaseBtn.disabled =
      state.vouchers.length === 0 || total <= 0 || total > totalBalance;
  }

  async function confirmPurchase() {
    if (state.vouchers.length === 0 || !state.selectedProduct) return;
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
    // 개인정보 수집·이용 동의 확인
    const privacyAgreeEl = $('#privacy-agree');
    if (privacyAgreeEl && !privacyAgreeEl.checked) {
      privacyAgreeEl.focus();
      return toast('개인정보 수집 및 이용에 동의해 주세요.', 'error');
    }

    try {
      confirmPurchaseBtn.disabled = true;
      const result = await api('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          voucher_serials: state.vouchers.map(v => v.serial),
          product_id: state.selectedProduct.id,
          quantity: qty,
          ...shipping
        })
      });

      // 응답 반영: 사용된 상품권만큼 state.vouchers 의 잔액/상태 갱신
      // (서버가 반환한 updated vouchers 배열을 신뢰)
      if (Array.isArray(result.vouchers)) {
        const map = new Map(result.vouchers.map(v => [v.serial, v]));
        state.vouchers = state.vouchers
          .map(v => map.get(v.serial) || v)
          // 잔액이 0이고 사용완료된 상품권은 목록에서 자동 제거
          .filter(v => !(v.status === 'used' && v.balance <= 0));
      }
      renderVoucherList();

      // 사용 내역 요약 토스트
      const usageSummary = (result.usages || [])
        .map(u => `${u.voucher_serial} −${fmt(u.amount_used)}`)
        .join(' · ');
      toast(
        `🎉 구매 완료! 주문번호 #${result.order.id}\n${usageSummary} (남은 합계 잔액: ${fmt(getTotalBalance())})`,
        'success'
      );

      if (state.vouchers.length > 0) {
        showVoucherStatus(
          `✅ 합계 잔액: ${fmt(getTotalBalance())} (등록된 상품권 ${state.vouchers.length}장)`,
          'success'
        );
      } else {
        showVoucherStatus('등록된 상품권이 없습니다. 상품권 번호를 입력해 추가해 주세요.', 'info');
      }
      closePurchaseModal();
      loadProducts();
    } catch (e) {
      toast(`❌ ${e.message}`, 'error');
    } finally {
      confirmPurchaseBtn.disabled = false;
    }
  }

  // ── 이벤트 ──
  checkVoucherBtn.addEventListener('click', addVoucher);
  voucherInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addVoucher();
  });
  // 사용자가 전체 시리얼("HWN-2026-CU88538")을 붙여넣어도
  // prefix 부분은 자동 제거하여 뒷부분만 입력란에 남도록 함
  voucherInput.addEventListener('input', (e) => {
    const val = e.target.value;
    const upper = val.toUpperCase();
    // 전체 시리얼이 입력된 경우 prefix 제거
    if (upper.startsWith('HWN-2026-')) {
      e.target.value = upper.slice('HWN-2026-'.length);
    } else if (upper.replace(/-/g, '').startsWith('HWN2026') && upper.replace(/-/g, '').length > 7) {
      // 하이픈이 일부 빠진 경우도 처리
      e.target.value = upper.replace(/-/g, '').slice(7);
    } else if (val !== upper) {
      // 단순히 소문자 → 대문자 변환 (커서 위치 유지)
      const pos = e.target.selectionStart;
      e.target.value = upper;
      try { e.target.setSelectionRange(pos, pos); } catch (_) {}
    }
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

    postcodeLayer.classList.remove('hidden');
    postcodeLayer.setAttribute('aria-hidden', 'false');
    postcodeEmbed.innerHTML = '';

    new daum.Postcode({
      oncomplete: function (data) {
        let fullAddress = data.roadAddress || data.jibunAddress;
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
        closeAddressSearch();
        const detailInput = $('#recipient-address-detail');
        if (detailInput) detailInput.focus();
      },
      onclose: function () {
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

  // ── 개인정보 동의 자세히 보기 토글 ──
  const privacyToggleBtn = $('#privacy-toggle-btn');
  const privacyDetails = $('#privacy-details');
  if (privacyToggleBtn && privacyDetails) {
    privacyToggleBtn.addEventListener('click', () => {
      const isHidden = privacyDetails.classList.toggle('hidden');
      privacyToggleBtn.setAttribute('aria-expanded', String(!isHidden));
      privacyToggleBtn.textContent = isHidden ? '자세히 보기 ▼' : '접기 ▲';
    });
  }

  // ─────────────────────────────────────────────
  // 주문 내역 확인 (비회원 조회)
  // ─────────────────────────────────────────────
  const lookupNameEl = $('#lookup-name');
  const lookupPhone4El = $('#lookup-phone4');
  const lookupBtn = $('#lookup-order-btn');
  const lookupStatusEl = $('#lookup-status');
  const lookupResultEl = $('#lookup-result');

  const ORDER_STATUS_LABEL = {
    pending:    { label: '결제완료', cls: 'pending' },
    preparing:  { label: '배송준비', cls: 'preparing' },
    shipped:    { label: '배송중',   cls: 'shipped' },
    delivered:  { label: '배송완료', cls: 'delivered' },
    cancelled:  { label: '취소',     cls: 'cancelled' }
  };

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatPrice(n) {
    return (Number(n) || 0).toLocaleString() + '원';
  }

  function formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function showLookupStatus(msg, type) {
    if (!lookupStatusEl) return;
    lookupStatusEl.classList.remove('hidden', 'is-error', 'is-info', 'is-success');
    if (type) lookupStatusEl.classList.add('is-' + type);
    lookupStatusEl.textContent = msg;
  }

  function clearLookupStatus() {
    if (!lookupStatusEl) return;
    lookupStatusEl.classList.add('hidden');
    lookupStatusEl.textContent = '';
  }

  function renderLookupResults(items, meta) {
    if (!lookupResultEl) return;
    if (!items || items.length === 0) {
      lookupResultEl.classList.remove('hidden');
      lookupResultEl.innerHTML = `
        <div class="lookup-empty">
          <p>일치하는 주문이 없습니다.</p>
          <small>받는 분 성함이 주문 시 입력하신 이름과 정확히 일치하는지 확인해 주세요.</small>
        </div>
      `;
      return;
    }

    const verified = !!(meta && meta.verified);
    const verifyNote = verified
      ? `<div class="lookup-verified">✅ 본인 확인 완료 — 전체 정보가 표시됩니다.</div>`
      : `<div class="lookup-masked-note">🔒 개인정보 보호를 위해 일부 정보가 마스킹 처리되었습니다. 휴대폰 뒷 4자리를 입력하시면 전체 정보를 보실 수 있습니다.</div>`;

    const cards = items.map(o => {
      const s = ORDER_STATUS_LABEL[o.status] || ORDER_STATUS_LABEL.pending;
      return `
        <div class="order-card">
          <div class="order-card-head">
            <span class="order-card-date">${escapeHtml(formatDate(o.created_at))}</span>
            <span class="badge status-${s.cls}">${s.label}</span>
          </div>
          <div class="order-card-product">
            <strong>${escapeHtml(o.product_name || '-')}</strong>
            <span class="order-card-qty">× ${Number(o.quantity) || 1}</span>
          </div>
          <div class="order-card-price">${formatPrice(o.total_price)}</div>
          <dl class="order-card-info">
            <dt>받는 분</dt><dd>${escapeHtml(o.recipient_name || '-')}</dd>
            <dt>연락처</dt><dd>${escapeHtml(o.recipient_phone || '-')}</dd>
            <dt>주소</dt>
            <dd>
              ${o.recipient_zipcode ? `<small>[${escapeHtml(o.recipient_zipcode)}]</small> ` : ''}
              ${escapeHtml(o.recipient_address || '-')}
              ${o.recipient_address_detail ? `<br><small>${escapeHtml(o.recipient_address_detail)}</small>` : ''}
            </dd>
            ${o.delivery_memo ? `<dt>배송 메모</dt><dd>${escapeHtml(o.delivery_memo)}</dd>` : ''}
          </dl>
        </div>
      `;
    }).join('');

    lookupResultEl.classList.remove('hidden');
    lookupResultEl.innerHTML = `
      <div class="lookup-result-head">
        <strong>총 ${items.length}건의 주문</strong>
        ${meta && meta.total_matches > items.length ? `<small>(전체 ${meta.total_matches}건 중 최근 ${items.length}건)</small>` : ''}
      </div>
      ${verifyNote}
      <div class="order-card-list">${cards}</div>
    `;
  }

  async function lookupOrders() {
    clearLookupStatus();
    if (lookupResultEl) lookupResultEl.classList.add('hidden');

    const name = (lookupNameEl?.value || '').trim();
    const phone4 = (lookupPhone4El?.value || '').trim();

    if (!name) {
      showLookupStatus('받는 분 성함을 입력해 주세요.', 'error');
      lookupNameEl?.focus();
      return;
    }
    if (phone4 && !/^\d{4}$/.test(phone4)) {
      showLookupStatus('휴대폰 뒷 4자리는 숫자 4자리로 입력해 주세요.', 'error');
      lookupPhone4El?.focus();
      return;
    }

    lookupBtn.disabled = true;
    const originalLabel = lookupBtn.textContent;
    lookupBtn.textContent = '조회 중...';

    try {
      const params = new URLSearchParams({ name });
      if (phone4) params.set('phone4', phone4);
      const res = await fetch('/api/orders/lookup?' + params.toString());
      const data = await res.json();
      if (!res.ok || !data.success) {
        showLookupStatus(data.error || '조회에 실패했습니다.', 'error');
        return;
      }
      renderLookupResults(data.data, data.meta);
    } catch (e) {
      console.error('lookupOrders error:', e);
      showLookupStatus('네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', 'error');
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = originalLabel;
    }
  }

  if (lookupBtn) lookupBtn.addEventListener('click', lookupOrders);
  // Enter 키로도 조회
  [lookupNameEl, lookupPhone4El].forEach(el => {
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        lookupOrders();
      }
    });
  });
  // 휴대폰 뒷 4자리는 숫자만
  if (lookupPhone4El) {
    lookupPhone4El.addEventListener('input', (e) => {
      e.target.value = (e.target.value || '').replace(/\D/g, '').slice(0, 4);
    });
  }

  // ── 초기화 ──
  loadProducts();
})();
