/**
 * 상품권 일련번호 생성 및 이미지 생성 모듈
 */
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'images', 'voucher-template.png');

// canvas 모듈 안전 로딩 (설치 실패 시에도 서버는 뜨도록)
let createCanvas, loadImage, registerFont;
let canvasAvailable = false;
try {
  const canvasMod = require('canvas');
  createCanvas = canvasMod.createCanvas;
  loadImage = canvasMod.loadImage;
  registerFont = canvasMod.registerFont;
  canvasAvailable = true;
} catch (e) {
  console.warn('[Voucher] ⚠️  canvas 모듈 로드 실패 — 상품권 이미지 생성 비활성. 나머지 기능은 정상 작동.');
  console.warn('[Voucher]    상세:', e.message);
}

// 한글 폰트 등록 시도
// 1순위: 프로젝트 번들 폰트 (Vercel/Production 에서도 동작)
// 2순위: 시스템 폰트 (sandbox/dev 에서만 존재)
const KOREAN_FONT_CANDIDATES = [
  path.join(__dirname, '..', 'assets', 'fonts', 'NanumGothicBold.ttf'),
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf'
];

let KOREAN_FONT_FAMILY = 'sans-serif';
if (canvasAvailable) {
  for (const fp of KOREAN_FONT_CANDIDATES) {
    if (fs.existsSync(fp)) {
      try {
        registerFont(fp, { family: 'KoreanFont' });
        KOREAN_FONT_FAMILY = 'KoreanFont';
        console.log('[Voucher] 한글 폰트 등록:', fp);
        break;
      } catch (e) {
        // 무시
      }
    }
  }
}

/**
 * 상품권 일련번호 생성: 앞 2자리 영문 + 5자리 숫자
 * 예: AF93875
 */
function generateSerialCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const num = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `${l1}${l2}${num}`;
}

/**
 * 풀 시리얼 코드 생성 (WELLS-YYYY-XXNNNNN)
 * K-웰스몰 브랜드. 하위 호환성을 위해 기존 HWN-2026-XXXXX 상품권도 유효.
 */
function generateFullSerial() {
  const year = new Date().getFullYear();
  return `WELLS-${year}-${generateSerialCode()}`;
}

/**
 * K-웰스몰 상품권 이미지 PNG 버퍼 생성
 *
 * 템플릿: public/images/voucher-template.png (K-웰스몰 디자인, 2026-10 신규)
 *   - 중앙 금액 자리, 등록코드 박스, 바코드 아래, 좌하단 No. 모두 빈 상태
 *   - 그 위에 금액(센터), 등록코드, 바코드숫자, No.번호만 그려 넣음
 *
 * 템플릿 레이아웃 좌표 (좌표는 전체 크기에 대한 비율 %):
 *   • AMOUNT (중앙 금액):   X 33~67%,  Y 34~70%  (center 50%, 52%)
 *   • CODE_BOX (등록코드):  X 33.4~66.4%, Y 77.8~85.8% (center 49.9%, 81.8%)
 *   • BARCODE_NUM (바코드 아래): X 70.5~94.5%, Y 87.8~92.5% (center 82.5%, 90.1%)
 *   • NO_LABEL (좌하단 No.): X 4.8~20%, Y 86~91% (center 12.4%, 88.5%)
 */
async function renderVoucherImage({ serial, amount }) {
  if (!canvasAvailable) {
    throw new Error('canvas 모듈이 설치되지 않아 상품권 이미지를 생성할 수 없습니다. 서버 로그를 확인하세요.');
  }
  const template = await loadImage(TEMPLATE_PATH);
  const W = template.width;
  const H = template.height;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // ── 1. 금액 (중앙 큰 글씨) ──
  // "50,000P" 형식 (단위: P = 포인트/원)
  // 참조 디자인은 "50,000P"이지만, 사용자 익숙성 위해 "50,000원"으로 표기
  const amountText = `${amount.toLocaleString('ko-KR')}원`;
  const amountCenterX = W * 0.50;
  const amountCenterY = H * 0.52;

  // 금색 그라데이션
  const grad = ctx.createLinearGradient(0, amountCenterY - H * 0.10, 0, amountCenterY + H * 0.10);
  grad.addColorStop(0, '#F5D98A');   // 밝은 상단
  grad.addColorStop(0.5, '#C5A059'); // 중간 금색
  grad.addColorStop(1, '#8B6914');   // 어두운 하단
  ctx.fillStyle = grad;

  // 폰트 크기: 템플릿 높이의 약 18%
  const amountFontSize = Math.round(H * 0.18);
  ctx.font = `bold ${amountFontSize}px "${KOREAN_FONT_FAMILY}"`;

  // 부드러운 그림자 (금속 효과)
  ctx.shadowColor = 'rgba(139, 105, 20, 0.35)';
  ctx.shadowBlur = Math.round(H * 0.012);
  ctx.shadowOffsetY = Math.round(H * 0.004);
  ctx.fillText(amountText, amountCenterX, amountCenterY);
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // ── 2. 등록코드 박스 (중앙 하단) ──
  // "등록코드 : WELLS-2026-XXXXX" 형식
  const codeCenterX = W * 0.499;
  const codeCenterY = H * 0.818;
  const codeText = `등록코드 : ${serial}`;
  const codeFontSize = Math.round(H * 0.038);
  ctx.font = `bold ${codeFontSize}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = '#1B3F2E'; // 다크 포레스트 그린
  ctx.fillText(codeText, codeCenterX, codeCenterY);

  // ── 3. 바코드 아래 숫자 ──
  // 바코드 밑에 사람이 읽을 수 있는 코드 표시
  const barcodeCenterX = W * 0.825;
  const barcodeCenterY = H * 0.901;
  const barcodeFontSize = Math.round(H * 0.028);
  ctx.font = `${barcodeFontSize}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = '#333333';
  ctx.fillText(serial, barcodeCenterX, barcodeCenterY);

  // ── 4. 좌하단 No. (일련번호 표기) ──
  // "No. 50000-2026-0910-NNNNNN" 형식 (장식용 번호)
  const noCenterX = W * 0.124;
  const noCenterY = H * 0.885;
  const noFontSize = Math.round(H * 0.026);
  ctx.font = `${noFontSize}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = '#1B3F2E';
  // amount로부터 숫자 코드 생성 (예: 50000-2026-MMDD-serial후반부)
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  // serial 뒷 6자리 (예: WELLS-2026-AF93875 → "93875"에서 마지막 5~6자리)
  const serialTail = serial.replace(/\D/g, '').slice(-6).padStart(6, '0');
  const noText = `No. ${amount}-${now.getFullYear()}-${mm}${dd}-${serialTail}`;
  ctx.fillText(noText, noCenterX, noCenterY);

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateSerialCode,
  generateFullSerial,
  renderVoucherImage
};
