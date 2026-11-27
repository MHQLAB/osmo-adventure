// تصنيف البكسلات: نموذج الطاولة + فئات ألوان القطع. وحدة صرفة.
// مبدأ: لا لون مطلق وحده. البكسل يُستبعد أولًا إذا شابه سطح الطاولة (أيًا كان لونه)،
// ثم يُنسب لأقرب لون قطعة. الشكل والرمز يحسمان النوع لاحقًا.

export const L = { BG: 0, BLUE: 1, RED: 2, ORANGE: 3, YELLOW: 4, TEAL: 5, PURPLE: 6, MAGENTA: 7, NEUTRAL: 8, INK: 9 };
// ألوان عرض القناع في التشخيص
export const LABEL_COLORS = [[40, 30, 20], [30, 120, 255], [255, 40, 60], [255, 140, 0], [255, 220, 0], [0, 200, 170], [110, 60, 200], [230, 60, 200], [210, 210, 210], [0, 0, 0]];
export const LABEL_NAMES = ['bg', 'blue', 'red', 'orange', 'yellow', 'teal', 'purple', 'magenta', 'neutral', 'ink'];

// نماذج أولية (تدرج°، تشبع، قيمة) من عيّنتي تطوير حقيقيتين (صورة هاتف + إطار آيباد عبر العاكس، 2026-11-27).
// minS: حد أدنى للتشبع لكل لون — يرفض الجلد والخشب الباهت (أقل تشبعًا من القطع البلاستيكية).
export const PROTOTYPES = [
  { label: L.BLUE, h: 197, s: 0.88, v: 0.63, minS: 0.45 }, { label: L.BLUE, h: 201, s: 0.83, v: 0.83, minS: 0.45 },
  { label: L.RED, h: 354, s: 0.85, v: 0.74, minS: 0.5 }, { label: L.RED, h: 2, s: 0.74, v: 1.0, minS: 0.5 },
  { label: L.ORANGE, h: 16, s: 0.72, v: 0.9, minS: 0.55 },
  { label: L.YELLOW, h: 43, s: 0.85, v: 0.72, minS: 0.55 },
  { label: L.TEAL, h: 170, s: 0.63, v: 0.58, minS: 0.35 }, { label: L.TEAL, h: 173, s: 0.61, v: 0.73, minS: 0.35 },
  { label: L.PURPLE, h: 245, s: 0.5, v: 0.3, minS: 0.25 }, { label: L.PURPLE, h: 241, s: 0.42, v: 0.4, minS: 0.25 },
  { label: L.MAGENTA, h: 322, s: 0.5, v: 0.68, minS: 0.3 },
];
const HUE_W = 6; // وزن التدرج: 10° فرق = 0.33 (كان 3 فخلط الأحمر بالبرتقالي)

export function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, mx ? d / mx : 0, mx / 255];
}

const median = (arr) => { if (!arr.length) return 0; const s = Float32Array.from(arr).sort(); return s[s.length >> 1]; };

/**
 * نموذج الطاولة من «اللون الغالب» فقط: قمة مدرج اللونية (r,g) ثم الوسيط والانحراف داخل عنقودها.
 * إصلاح v0.4: النموذج السابق أخذ وسيط كل البكسلات، فوسّعت اليدان والقطع حد التشابه إلى 0.168
 * فابتلع الأحمر والأصفر والرمادي. الحد الآن بين 0.035 و0.07.
 */
export function tableModel(rgba, w, h, step = 3) {
  const B = 100, hist = new Uint32Array(B * B), rs = [], gs = [], vs = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const p = (y * w + x) * 4; const R = rgba[p], G = rgba[p + 1], Bl = rgba[p + 2]; const S = R + G + Bl + 1;
    const r = R / S, g = G / S; rs.push(r); gs.push(g); vs.push(Math.max(R, G, Bl) / 255);
    hist[Math.min(B - 1, (r * B) | 0) * B + Math.min(B - 1, (g * B) | 0)]++;
  }
  // تنعيم 3×3 ثم القمة
  let best = 0, bi = 0;
  for (let i = 1; i < B - 1; i++) for (let j = 1; j < B - 1; j++) {
    let sum = 0; for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) sum += hist[(i + di) * B + j + dj];
    if (sum > best) { best = sum; bi = i * B + j; }
  }
  const pr = ((bi / B) | 0) / B + 0.005, pg = (bi % B) / B + 0.005;
  const near = []; for (let k = 0; k < rs.length; k++) if (Math.hypot(rs[k] - pr, gs[k] - pg) < 0.05) near.push(k);
  const sel = near.length >= 20 ? near : rs.map((_, k) => k);
  const mr = median(sel.map((k) => rs[k])), mg = median(sel.map((k) => gs[k])), mv = median(sel.map((k) => vs[k]));
  const mad = median(sel.map((k) => Math.hypot(rs[k] - mr, gs[k] - mg)));
  return { r: mr, g: mg, v: mv, mad, tol: Math.min(0.07, Math.max(0.035, 4 * mad)), share: +(sel.length / rs.length).toFixed(2) };
}

/**
 * يصنف كل بكسل. gains تصحيح الإضاءة من illuminant.js (اختياري).
 * @returns {{labels:Uint8Array, s:Float32Array, v:Float32Array}}
 */
export function classifyPixels(rgba, w, h, table, gains = [1, 1, 1]) {
  const n = w * h, labels = new Uint8Array(n), sat = new Float32Array(n), val = new Float32Array(n);
  const [gr, gg, gb] = gains;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const R = Math.min(255, rgba[p] * gr), G = Math.min(255, rgba[p + 1] * gg), B = Math.min(255, rgba[p + 2] * gb);
    const [hh, s, v] = rgbToHsv(R, G, B);
    sat[i] = s; val[i] = v;
    // حبر داكن (سهم/رقم/أيقونة داكنة): داكن ومنخفض التشبع — قبل نموذج الطاولة لأن الظلال العميقة نادرة
    // الحبر نسبي لإضاءة المشهد (إطار الآيباد: السهم الرمادي الداكن v≈0.35–0.45)
    // التشبع ≤0.3: الحبر رمادي (السهم/الرقم s≈0.1)، أما جسم «الراحة» البنفسجي الداكن (s≈0.42) فليس حبرًا
    if (s < 0.3 && v < Math.min(0.5, table.v * 0.62)) { labels[i] = L.INK; continue; }
    const S = R + G + B + 1;
    const dTable = Math.hypot(R / S - table.r, G / S - table.g);
    const vr = v / (table.v || 1);
    if (dTable < table.tol && vr > 0.5 && vr < 1.5) { labels[i] = L.BG; continue; } // سطح الطاولة (أو ظله)
    if (s < 0.16 && v > 0.3) { labels[i] = L.NEUTRAL; continue; }
    if (s < 0.25 || v < 0.15) { labels[i] = L.BG; continue; }
    let best = L.BG, bd = Infinity;
    for (const pr of PROTOTYPES) {
      if (s < pr.minS) continue;
      let dh = Math.abs(hh - pr.h); if (dh > 180) dh = 360 - dh;
      const d = HUE_W * (dh / 180) + Math.abs(s - pr.s) + 0.6 * Math.abs(v - pr.v);
      if (d < bd) { bd = d; best = pr.label; }
    }
    labels[i] = bd < 0.75 ? best : L.BG;
  }
  return { labels, s: sat, v: val };
}

/** تنعيم: يملأ البكسل بالفئة الغالبة إن أحاطت به (يسد فجوات الضوضاء الصغيرة). */
export function majorityFill(labels, w, h, minVotes = 5) {
  const out = labels.slice();
  const counts = new Uint8Array(10);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    counts.fill(0);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) counts[labels[i + dy * w + dx]]++;
    let best = labels[i], bc = 0;
    for (let k = 1; k <= 8; k++) if (counts[k] > bc) { bc = counts[k]; best = k; }
    if (bc >= minVotes && labels[i] !== best && (labels[i] === L.BG || counts[labels[i]] <= 1)) out[i] = best;
  }
  return out;
}
