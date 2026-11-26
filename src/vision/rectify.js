// تقويم المنظور: تحويل منطقة اللعب (رباعي في الصورة المصححة) إلى مستطيل علوي.
import { homographyFromPoints } from './geometry.js';

/**
 * يبني خريطة فهارس: لكل بكسل في المخرج، فهرس البكسل المقابل في المصدر (أو -1).
 * تُبنى مرة واحدة عند تغيّر المعايرة، ثم يكون التقويم لكل إطار نسخًا سريعًا.
 * @param {Array<[number,number]>} cornersPx زوايا منطقة اللعب بالبكسل (TL,TR,BR,BL)
 */
export function buildRemap(cornersPx, srcW, srcH, outW, outH) {
  const dstRect = [[0, 0], [outW - 1, 0], [outW - 1, outH - 1], [0, outH - 1]];
  const H = homographyFromPoints(dstRect, cornersPx); // مخرج ← مصدر
  const map = new Int32Array(outW * outH);
  let i = 0;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++, i++) {
      const w = H[6] * x + H[7] * y + H[8];
      const sx = Math.round((H[0] * x + H[1] * y + H[2]) / w);
      const sy = Math.round((H[3] * x + H[4] * y + H[5]) / w);
      map[i] = sx >= 0 && sy >= 0 && sx < srcW && sy < srcH ? sy * srcW + sx : -1;
    }
  }
  return map;
}

/** ينسخ البكسلات عبر الخريطة. src/dst من نوع Uint8ClampedArray بصيغة RGBA. */
export function remapRGBA(src, dst, map) {
  for (let i = 0, n = map.length; i < n; i++) {
    const s = map[i];
    const o = i << 2;
    if (s < 0) { dst[o] = dst[o + 1] = dst[o + 2] = 0; dst[o + 3] = 255; continue; }
    const p = s << 2;
    dst[o] = src[p]; dst[o + 1] = src[p + 1]; dst[o + 2] = src[p + 2]; dst[o + 3] = 255;
  }
  return dst;
}

/** حجم المخرج وفق نسبة منطقة اللعب وحد أقصى للضلع الأطول. */
export function outputSize(aspect, maxSide) {
  if (aspect >= 1) return { w: maxSide, h: Math.max(1, Math.round(maxSide / aspect)) };
  return { w: Math.max(1, Math.round(maxSide * aspect)), h: maxSide };
}

/** تقدير نسبة العرض/الارتفاع الحقيقية للرباعي من متوسط أطوال الأضلاع. */
export function estimateAspect(c) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const w = (d(c[0], c[1]) + d(c[3], c[2])) / 2;
  const h = (d(c[0], c[3]) + d(c[1], c[2])) / 2;
  return h > 0 ? w / h : 1;
}
