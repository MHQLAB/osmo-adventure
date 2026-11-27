// هندسة الصورة: تحويلات الدوران/الانعكاس، والمصفوفة الإسقاطية (Homography).
// وحدة صرفة بلا اعتماد على المتصفح — قابلة للاختبار في Node.

/** حل نظام خطي Ax=b بحذف غاوس مع اختيار المحور الجزئي. */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('singular');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * يحسب H (3x3 مسطحة، 9 عناصر) بحيث dst ≈ H·src لأربع نقاط.
 * @param {Array<[number,number]>} src
 * @param {Array<[number,number]>} dst
 */
export function homographyFromPoints(src, dst) {
  if (src.length !== 4 || dst.length !== 4) throw new Error('need 4 points');
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** ترتيب أربع نقاط: أعلى-يسار، أعلى-يمين، أسفل-يمين، أسفل-يسار. */
export function orderCorners(pts) {
  if (pts.length !== 4) throw new Error('need 4 points');
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx)
  );
  // atan2 بمحور y للأسفل: الترتيب الناتج يبدأ من الأعلى-يسار تقريبًا (الزاوية الأصغر ≈ -135°)
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => { const s = p[0] + p[1]; if (s < best) { best = s; start = i; } });
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

/** هل الرباعي محدّب وغير متداخل؟ (شرط لمعايرة صالحة) */
export function isConvexQuad(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

export function quadArea(pts) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

const COS = { 0: 1, 90: 0, 180: -1, 270: 0 };
const SIN = { 0: 0, 90: 1, 180: 0, 270: -1 };

export function normalizeRotation(r) {
  const v = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return v;
}

/**
 * مصفوفة Canvas (a,b,c,d,e,f) لتحويل إطار الكاميرا الخام (w×h) إلى الصورة المصححة.
 * الترتيب: انعكاس حول المركز ثم دوران مع عقارب الساعة.
 */
export function orientationTransform(w, h, { rotation = 0, flipH = false, flipV = false } = {}) {
  const r = normalizeRotation(rotation);
  const swap = r === 90 || r === 270;
  const outW = swap ? h : w;
  const outH = swap ? w : h;
  const cos = COS[r], sin = SIN[r];
  const sx = flipH ? -1 : 1, sy = flipV ? -1 : 1;
  // M = T(outW/2,outH/2) · R · S · T(-w/2,-h/2)
  const a = cos * sx, b = sin * sx, c = -sin * sy, d = cos * sy;
  const e = outW / 2 + a * (-w / 2) + c * (-h / 2);
  const f = outH / 2 + b * (-w / 2) + d * (-h / 2);
  return { outW, outH, matrix: [a, b, c, d, e, f] };
}

export function mapPoint([a, b, c, d, e, f], x, y) {
  return [a * x + c * y + e, b * x + d * y + f];
}

/**
 * أعلى تقريب (zoom) مركزي يُبقي كل الزوايا داخل الإطار مع هامش.
 * التقريب في الكاميرا يقص حول المركز؛ والدوران/الانعكاس حول المركز لا يغيّر ذلك.
 */
export function zoomForCorners(cornersNorm, maxZoom = 1, margin = 0.03) {
  const d = Math.max(...cornersNorm.map(([x, y]) => Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)))) + margin;
  return Math.max(1, Math.min(maxZoom, 0.5 / Math.max(d, 1e-6)));
}

/** تحويل الزوايا النسبية عند تغيير التقريب من zFrom إلى zTo. */
export function remapCornersForZoom(cornersNorm, zFrom, zTo) {
  const k = zTo / zFrom;
  return cornersNorm.map(([x, y]) => [0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k]);
}
