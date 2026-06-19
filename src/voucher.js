/**
 * 상품권 일련번호 생성 및 이미지 생성 모듈
 */
const { createCanvas, loadImage, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', 'public', 'images', 'voucher-template.png');

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

  /**
   * 원본 텍스트 위치 (이미지 정밀 분석 결과):
   *  - "PREMIUM GIFT VOUCHER": Y 39.2%~50.9%
   *  - "100,000원":            Y 53.0%~75.7%  (X 32.9%~70.0%)
   *  - "HWN-2026-0000001":     Y 85.3%~92.2%
   *
   * 새 박스는 원본 텍스트보다 충분히 크게 잡아서, 가장자리 페이드 구역에서도
   * 원본 텍스트가 비치지 않도록 함 (완전 불투명 영역이 원본 텍스트 전체를 덮음).
   */

  // ── 1. 금액 영역: 기존 "100,000원" 완전 덮어쓰기 ──
  // 원본 텍스트: Y 53~75.7%. 박스는 Y 48~80%로 잡고, 페이드는 상하 8%만 사용
  // → 완전 불투명 영역(56~72% 사이)만으로도 원본 텍스트 전체를 덮음
  const amountText = `${amount.toLocaleString('ko-KR')}원`;
  const amountBoxY = Math.round(H * 0.48);
  const amountBoxH = Math.round(H * 0.32); // 48% ~ 80%
  const amountBoxX = Math.round(W * 0.10);
  const amountBoxW = Math.round(W * 0.80); // 10% ~ 90%

  drawOverlayBox(ctx, amountBoxX, amountBoxY, amountBoxW, amountBoxH);

  // 금색 그라데이션 텍스트 (영역 중심에 배치)
  const amountCenterY = amountBoxY + amountBoxH / 2;
  const textGrad = ctx.createLinearGradient(0, amountCenterY - H * 0.08, 0, amountCenterY + H * 0.08);
  textGrad.addColorStop(0, '#fff3b0');
  textGrad.addColorStop(0.5, '#e6b800');
  textGrad.addColorStop(1, '#a67c00');

  ctx.font = `bold ${Math.round(H * 0.16)}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = textGrad;
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 8;
  ctx.fillText(amountText, W / 2, amountCenterY);
  ctx.shadowBlur = 0;

  // ── 2. 일련번호 영역: 기존 시리얼 완전 덮어쓰기 ──
  // 원본 위치: Y 85.3%~92.2%. 박스는 Y 82%~96%로 크게 잡음
  const serialBoxY = Math.round(H * 0.82);
  const serialBoxH = Math.round(H * 0.14); // 82% ~ 96%
  const serialBoxX = Math.round(W * 0.15);
  const serialBoxW = Math.round(W * 0.70); // 15% ~ 85%

  drawOverlayBox(ctx, serialBoxX, serialBoxY, serialBoxW, serialBoxH);

  ctx.font = `bold ${Math.round(H * 0.05)}px "${KOREAN_FONT_FAMILY}"`;
  ctx.fillStyle = '#d4b465';
  ctx.fillText(serial, W / 2, serialBoxY + serialBoxH / 2);

  return canvas.toBuffer('image/png');
}

/**
 * 원본 텍스트를 완전히 가리는 오버레이 박스 그리기
 * - 중앙: 완전 불투명 검정 (원본이 비치지 않음)
 * - 좌우: 부드러운 페이드아웃 (경계가 두드러지지 않음)
 * - 상하: 부드러운 페이드아웃
 */
function drawOverlayBox(ctx, x, y, w, h) {
  ctx.save();
  // 가로 페이드를 위한 그라디언트
  const horizFade = 0.10; // 좌우 10%씩 페이드 (완전 불투명 영역을 넓게)
  const vertFade = 0.18;  // 상하 18%씩 페이드 (위/아래로 자연스럽게 사라짐)

  // 중앙은 완전 불투명, 좌우/상하 가장자리만 부드럽게 페이드
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, 'rgba(8,8,8,0)');
  grad.addColorStop(horizFade, 'rgba(8,8,8,1)');
  grad.addColorStop(1 - horizFade, 'rgba(8,8,8,1)');
  grad.addColorStop(1, 'rgba(8,8,8,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // 위쪽 페이드 (alpha 마스킹)
  ctx.globalCompositeOperation = 'destination-out';
  const topFade = ctx.createLinearGradient(0, y, 0, y + h * vertFade);
  topFade.addColorStop(0, 'rgba(0,0,0,1)');
  topFade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = topFade;
  ctx.fillRect(x, y, w, h * vertFade);

  // 아래쪽 페이드
  const botFade = ctx.createLinearGradient(0, y + h * (1 - vertFade), 0, y + h);
  botFade.addColorStop(0, 'rgba(0,0,0,0)');
  botFade.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = botFade;
  ctx.fillRect(x, y + h * (1 - vertFade), w, h * vertFade);
  ctx.restore();
}

module.exports = {
  generateSerialCode,
  generateFullSerial,
  renderVoucherImage
};
