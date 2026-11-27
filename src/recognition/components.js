// المكونات المتصلة وخصائص الشكل (عزوم، اتجاه، طول/عرض، دائرية). وحدة صرفة.

/** مكونات متصلة (اتصال رباعي) لفئة معينة. يعيد قائمة بكسلات كل مكون كمؤشرات. */
export function components(labels, w, h, label, minArea = 20) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== label || seen[i]) continue;
    let sp = 0; stack[sp++] = i; seen[i] = 1;
    const px = [];
    while (sp) {
      const j = stack[--sp]; px.push(j);
      const x = j % w, y = (j / w) | 0;
      if (x > 0 && !seen[j - 1] && labels[j - 1] === label) { seen[j - 1] = 1; stack[sp++] = j - 1; }
      if (x < w - 1 && !seen[j + 1] && labels[j + 1] === label) { seen[j + 1] = 1; stack[sp++] = j + 1; }
      if (y > 0 && !seen[j - w] && labels[j - w] === label) { seen[j - w] = 1; stack[sp++] = j - w; }
      if (y < h - 1 && !seen[j + w] && labels[j + w] === label) { seen[j + w] = 1; stack[sp++] = j + w; }
    }
    if (px.length >= minArea) out.push(px);
  }
  return out;
}

/** خصائص الشكل من العزوم: المركز، زاوية المحور الأكبر، الطول والعرض المكافئان لمستطيل. */
export function shapeOf(px, w) {
  let sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const j of px) { const x = j % w, y = (j / w) | 0; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const n = px.length, cx = sx / n, cy = sy / n;
  let m20 = 0, m02 = 0, m11 = 0;
  for (const j of px) { const dx = (j % w) - cx, dy = ((j / w) | 0) - cy; m20 += dx * dx; m02 += dy * dy; m11 += dx * dy; }
  m20 /= n; m02 /= n; m11 /= n;
  const theta = 0.5 * Math.atan2(2 * m11, m20 - m02);
  const common = Math.sqrt(((m20 - m02) / 2) ** 2 + m11 ** 2);
  const l1 = (m20 + m02) / 2 + common, l2 = Math.max(1e-6, (m20 + m02) / 2 - common);
  const length = Math.sqrt(12 * l1), width = Math.sqrt(12 * l2);
  return { area: n, cx, cy, theta, length, width, elong: length / width, bbox: [x0, y0, x1, y1], fill: n / (length * width) };
}

/**
 * أقصى نصف قطر لكل قطاع زاوي حول المركز → معامل الاختلاف (دائرة ≈ 0، مربع ≈ 0.1، نجمة > 0.18).
 * whiten: تطبيع تغاير الشكل أولًا (المنظور عبر المرآة يجعل الدائرة بيضاوية؛ التطبيع يعيدها دائرة
 * بينما يبقى المربع مربعًا لأن تغايره متساوٍ أصلًا).
 */
export function radialProfileCV(px, w, cx, cy, bins = 36, whiten = true) {
  let T = [1, 0, 0, 1];
  if (whiten) {
    let a = 0, b = 0, c = 0; for (const j of px) { const dx = (j % w) - cx, dy = ((j / w) | 0) - cy; a += dx * dx; b += dy * dy; c += dx * dy; }
    a /= px.length; b /= px.length; c /= px.length;
    // Σ^{-1/2} لمصفوفة 2×2 متماثلة
    const tr = a + b, det = a * b - c * c; if (det > 1e-9) {
      const sq = Math.sqrt(det), t2 = Math.sqrt(tr + 2 * sq);
      const m = [(a + sq) / t2, c / t2, c / t2, (b + sq) / t2]; // Σ^{1/2}
      const md = m[0] * m[3] - m[1] * m[2];
      T = [m[3] / md, -m[1] / md, -m[2] / md, m[0] / md];
    }
  }
  const maxR = new Float32Array(bins);
  for (const j of px) {
    const dx0 = (j % w) - cx, dy0 = ((j / w) | 0) - cy;
    const dx = T[0] * dx0 + T[1] * dy0, dy = T[2] * dx0 + T[3] * dy0;
    const bb = Math.min(bins - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * bins));
    const r = Math.hypot(dx, dy); if (r > maxR[bb]) maxR[bb] = r;
  }
  let sum = 0, k = 0; for (const r of maxR) if (r > 0) { sum += r; k++; }
  if (k < bins * 0.6) return null;
  const mean = sum / k; let v = 0; for (const r of maxR) if (r > 0) v += (r - mean) ** 2;
  return Math.sqrt(v / k) / mean;
}

/** نسبة أبعاد مكوّن دائري (المحور الأكبر/الأصغر) — من أقراص الأسهم لقياس تشوه المنظور. */
export function ellipseAspect(px, w) {
  let cx = 0, cy = 0; for (const j of px) { cx += j % w; cy += (j / w) | 0; } cx /= px.length; cy /= px.length;
  let a = 0, b = 0; for (const j of px) { a += ((j % w) - cx) ** 2; b += (((j / w) | 0) - cy) ** 2; }
  return Math.sqrt(a / Math.max(b, 1e-6)); // >1: أعرض من ارتفاعه
}

/** يملأ الثقوب المغلقة داخل مكون (لاستخراج الحبر أو الأيقونة المحاطة به) ضمن مستطيله المحيط. */
export function holesOf(px, w, bbox, pad = 1) {
  const [x0, y0, x1, y1] = bbox;
  const bw = x1 - x0 + 1 + 2 * pad, bh = y1 - y0 + 1 + 2 * pad;
  const m = new Uint8Array(bw * bh);
  for (const j of px) m[((((j / w) | 0) - y0 + pad) * bw) + ((j % w) - x0 + pad)] = 1;
  // غمر الخلفية الخارجية من الحدود
  const out = new Uint8Array(bw * bh); const st = [];
  for (let x = 0; x < bw; x++) { st.push(x, (bh - 1) * bw + x); }
  for (let y = 0; y < bh; y++) { st.push(y * bw, y * bw + bw - 1); }
  while (st.length) {
    const i = st.pop(); if (out[i] || m[i]) continue; out[i] = 1;
    const x = i % bw, y = (i / bw) | 0;
    if (x > 0) st.push(i - 1); if (x < bw - 1) st.push(i + 1); if (y > 0) st.push(i - bw); if (y < bh - 1) st.push(i + bw);
  }
  const holes = [];
  for (let i = 0; i < bw * bh; i++) if (!m[i] && !out[i]) holes.push(((((i / bw) | 0) + y0 - pad) * w) + (i % bw) + x0 - pad);
  return holes;
}
