/**
 * 상품권 일련번호 생성 및 이미지 생성 모듈
 */
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'images', 'voucher-template.png');

// 시스템에 설치된 한글 폰트 등록 시도 (Noto Sans CJK)
const KOREAN_FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf',
  '/usr/share/fonts/truetype/nanum/NanumGothic.ttf'
];

let KOREAN_FONT_FAMILY = 'sans-serif';
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
 * 풀 시리얼 코드 생성 (HWN-YYYY-XXNNNNN)
 */
function generateFullSerial() {
  const year = new Date().getFullYear();
  return `HWN-${year}-${generateSerialCode()}`;
}

/**
 * 상품권 이미지 PNG 버퍼 생성
 * - 템플릿 이미지 위에 일련번호와 금액을 오버레이
 */
async function renderVoucherImage({ serial, amount }) {
  const template = await loadImage(TEMPLATE_PATH);
  const W = template.width;
  const H = template.height;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(template, 0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // 1. 기존 금액(100,000원) 영역을 부드럽게 덮어쓰기
  const amountText = `${amount.toLocaleString('ko-KR')}원`;
  const amountBoxY = Math.round(H * 0.57);
  const amountBoxH = Math.round(H * 0.16);
  const amountBoxX = Math.round(W * 0.18);
  const amountBoxW = Math.round(W * 0.64);

  // 그라데이션 박스로 자연스럽게 덮음 (좌우 페이드 + 라운드)
  ctx.save();
  const bgGrad = ctx.createLinearGradient(amountBoxX, 0, amountBoxX + amountBoxW, 0);
  bgGrad.addColorStop(0, 'rgba(10,10,10,0)');
  bgGrad.addColorStop(0.25, 'rgba(10,10,10,0.98)');
  bgGrad.addColorStop(0.75, 'rgba(10,10,10,0.98)');
  bgGrad.addColorStop(1, 'rgba(10,10,10,0)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(amountBoxX, amountBoxY, amountBoxW, amountBoxH);
  ctx.restore();

  // 금색 그라데이션 텍스트
  const textGrad = ctx.createLinearGradient(0, amountBoxY, 0, amountBoxY + amountBoxH);
  textGrad.addColorStop(0, '#fff3b0');
  textGrad.addColorStop(0.5, '#e6b800');
  textGrad.addColorStop(1, '#a67c00');

  ctx.font = `bold ${Math.round(H * 0.13)}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = textGrad;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.fillText(amountText, W / 2, amountBoxY + amountBoxH / 2);
  ctx.shadowBlur = 0;

  // 2. 일련번호 영역도 부드럽게 덮어쓰기
  const serialBoxY = Math.round(H * 0.85);
  const serialBoxH = Math.round(H * 0.08);
  const serialBoxX = Math.round(W * 0.22);
  const serialBoxW = Math.round(W * 0.56);

  const serialBgGrad = ctx.createLinearGradient(serialBoxX, 0, serialBoxX + serialBoxW, 0);
  serialBgGrad.addColorStop(0, 'rgba(10,10,10,0)');
  serialBgGrad.addColorStop(0.2, 'rgba(10,10,10,0.95)');
  serialBgGrad.addColorStop(0.8, 'rgba(10,10,10,0.95)');
  serialBgGrad.addColorStop(1, 'rgba(10,10,10,0)');
  ctx.fillStyle = serialBgGrad;
  ctx.fillRect(serialBoxX, serialBoxY, serialBoxW, serialBoxH);

  ctx.font = `bold ${Math.round(H * 0.045)}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = '#d4b465';
  ctx.fillText(serial, W / 2, serialBoxY + serialBoxH / 2);

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateSerialCode,
  generateFullSerial,
  renderVoucherImage
};
