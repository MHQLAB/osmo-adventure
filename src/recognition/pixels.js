// تصنيف البكسلات: نموذج الطاولة + فئات ألوان القطع. وحدة صرفة.
// مبدأ: لا لون مطلق وحده. البكسل يُستبعد أولًا إذا شابه سطح الطاولة (أيًا كان لونه)،
// ثم يُنسب لأقرب لون قطعة. الشكل والرمز يحسمان النوع لاحقًا.

export const L = { BG: 0, BLUE: 1, RED: 2, ORANGE: 3, YELLOW: 4, TEAL: 5, PURPLE: 6, MAGENTA: 7, NEUTRAL: 8, INK: 9 };
export const LABEL_NAMES = ['bg', 'blue', 'red', 'orange', 'yellow', 'teal', 'purple', 'magenta', 'neutral', 'ink'];

// نماذج أولية (تدرج°، تشبع، قيمة) مقاسة من صورة القطع الحقيقية (عيّنة تطوير، 2026-11-27).
export const PROTOTYPES = [
  { label: L.BLUE, h: 197, s: 0.88, v: 0.63 },
  { label: L.RED, h: 354, s: 0.85, v: 0.74 },
  { label: L.ORANGE, h: 16, s: 0.72, v: 0.9 },
  { label: L.YELLOW, h: 43, s: 0.85, v: 0.72 },
  { label: L.TEAL, h: 170, s: 0.63, v: 0.58 },
  { label: L.PURPLE, h: 245, s: 0.5, v: 0.3 },
  { label: L.MAGENTA, h: 322, s: 0.5, v: 0.68 },
];

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

/** نموذج الطاولة: الوسيط والانحراف المطلق للونية (r,g) والقيمة على عيّنة من البكسلات. */
export function tableModel(rgba, w, h, step = 4) {
  const rs = [], gs = [], vs = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const p = (y * w + x) * 4; const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2]; const S = R + G + B + 1;
    rs.push(R / S); gs.push(G / S); vs.push(Math.max(R, G, B) / 255);
  }
  const mr = median(rs), mg = median(gs), mv = median(vs);
  const mad = median(rs.map((r, i) => Math.hypot(r - mr, gs[i] - mg)));
  return { r: mr, g: mg, v: mv, mad, tol: Math.max(0.045, 5 * mad) };
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
    if (v < 0.32 && s < 0.45 && v < table.v * 0.55) { labels[i] = L.INK; continue; }
    const S = R + G + B + 1;
    const dTable = Math.hypot(R / S - table.r, G / S - table.g);
    const vr = v / (table.v || 1);
    if (dTable < table.tol && vr > 0.5 && vr < 1.5) { labels[i] = L.BG; continue; } // سطح الطاولة (أو ظله)
    if (s < 0.16 && v > 0.3) { labels[i] = L.NEUTRAL; continue; }
    if (s < 0.25 || v < 0.15) { labels[i] = L.BG; continue; }
    let best = L.BG, bd = Infinity;
    for (const pr of PROTOTYPES) {
      let dh = Math.abs(hh - pr.h); if (dh > 180) dh = 360 - dh;
      const d = 3 * (dh / 180) + Math.abs(s - pr.s) + 0.6 * Math.abs(v - pr.v);
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
