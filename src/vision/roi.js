// اكتشاف منطقة اللعب تلقائيًا من صورة الطاولة الفارغة (أو شبه الفارغة).
// الفكرة: السطح الذي في وسط الصورة هو الطاولة. نصنف الخلايا المشابهة له لونيًا،
// نملأ الثقوب الصغيرة (قطع موضوعة)، ونستبعد إطار العاكس الأحمر والمناطق المعتمة،
// ثم نأخذ أكبر مستطيل يحتوي الوسط. لا يشترط لون طاولة معين، بل اختلافها عما حولها.

/** متوسطات الخلايا: [r,g,b,luma] لكل خلية. */
export function cellMeans(rgba, w, h, cols, rows) {
  const out = new Float32Array(cols * rows * 4);
  const cnt = new Uint32Array(cols * rows);
  for (let y = 0; y < h; y += 2) {
    const cy = Math.min(rows - 1, (y * rows / h) | 0);
    for (let x = 0; x < w; x += 2) {
      const cx = Math.min(cols - 1, (x * cols / w) | 0);
      const p = (y * w + x) * 4, c = cy * cols + cx;
      out[c * 4] += rgba[p]; out[c * 4 + 1] += rgba[p + 1]; out[c * 4 + 2] += rgba[p + 2]; cnt[c]++;
    }
  }
  for (let c = 0; c < cols * rows; c++) {
    const k = cnt[c] || 1;
    out[c * 4] /= k; out[c * 4 + 1] /= k; out[c * 4 + 2] /= k;
    out[c * 4 + 3] = (out[c * 4] * 77 + out[c * 4 + 1] * 150 + out[c * 4 + 2] * 29) / 256;
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** أكبر مستطيل من القيم 1 في مصفوفة ثنائية (خوارزمية المدرج التكراري). */
export function largestRectangle(mask, cols, rows, mustContain = null) {
  const heights = new Int32Array(cols);
  let best = null, bestArea = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) heights[c] = mask[r * cols + c] ? heights[c] + 1 : 0;
    const stack = [];
    for (let c = 0; c <= cols; c++) {
      const hgt = c === cols ? 0 : heights[c];
      let start = c;
      while (stack.length && stack[stack.length - 1][1] >= hgt) {
        const [s, sh] = stack.pop();
        const area = sh * (c - s);
        if (area > bestArea) {
          const rect = { x0: s, x1: c - 1, y0: r - sh + 1, y1: r };
          if (!mustContain || (mustContain[0] >= rect.x0 && mustContain[0] <= rect.x1 && mustContain[1] >= rect.y0 && mustContain[1] <= rect.y1)) {
            bestArea = area; best = rect;
          }
        }
        start = s;
      }
      stack.push([start, hgt]);
    }
  }
  return best ? { ...best, area: bestArea } : null;
}

/** يملأ مكونات «غير طاولة» المغلقة الصغيرة (قطع على الطاولة). */
function fillHoles(mask, cols, rows, maxHole) {
  const seen = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    if (mask[i] || seen[i]) continue;
    const comp = [i]; seen[i] = 1; let touches = false;
    for (let k = 0; k < comp.length; k++) {
      const j = comp[k], x = j % cols, y = (j / cols) | 0;
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) touches = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const q = ny * cols + nx; if (!mask[q] && !seen[q]) { seen[q] = 1; comp.push(q); }
      }
    }
    if (!touches && comp.length <= maxHole) for (const j of comp) mask[j] = 1;
  }
}

/**
 * @returns {{corners:Array<[number,number]>, confidence:number, tableFraction:number, reference:number[], mask:Uint8Array, cols:number, rows:number}|null}
 */
export function autoPlayArea(rgba, w, h, { cols = 32, rows = 18, chromaTol = 0.04, lumaLo = 0.55, lumaHi = 1.7, maxHole = 24 } = {}) {
  const m = cellMeans(rgba, w, h, cols, rows);
  const chroma = (c) => { const s = m[c * 4] + m[c * 4 + 1] + m[c * 4 + 2] + 1e-6; return [m[c * 4] / s, m[c * 4 + 1] / s]; };
  const blocked = (c) => {
    const R = m[c * 4], G = m[c * 4 + 1], B = m[c * 4 + 2], L = m[c * 4 + 3];
    if (L < 35) return true; // معتم: حافة الآيباد/القاعدة/ظل عميق
    if (R > 90 && R > 1.7 * G && R > 1.7 * B) return true; // إطار العاكس الأحمر
    return false;
  };
  // مرجع الطاولة: وسيط الخلايا الوسطى
  const rs = [], gs = [], ls = [];
  for (let y = Math.floor(rows * 0.35); y < Math.ceil(rows * 0.7); y++) for (let x = Math.floor(cols * 0.3); x < Math.ceil(cols * 0.7); x++) {
    const c = y * cols + x; if (blocked(c)) continue;
    const [r, g] = chroma(c); rs.push(r); gs.push(g); ls.push(m[c * 4 + 3]);
  }
  if (rs.length < 4) return null;
  const ref = [median(rs), median(gs), median(ls)];
  const mask = new Uint8Array(cols * rows);
  let tableCells = 0;
  for (let c = 0; c < cols * rows; c++) {
    if (blocked(c)) continue;
    const [r, g] = chroma(c); const L = m[c * 4 + 3];
    if (Math.abs(r - ref[0]) <= chromaTol && Math.abs(g - ref[1]) <= chromaTol && L >= ref[2] * lumaLo && L <= ref[2] * lumaHi) { mask[c] = 1; tableCells++; }
  }
  fillHoles(mask, cols, rows, maxHole);
  const rect = largestRectangle(mask, cols, rows, [cols >> 1, rows >> 1]);
  if (!rect) return null;
  // هامش نصف خلية للداخل
  const x0 = (rect.x0 + 0.5) / cols, x1 = (rect.x1 + 0.5) / cols, y0 = (rect.y0 + 0.5) / rows, y1 = (rect.y1 + 0.5) / rows;
  const areaFrac = rect.area / (cols * rows);
  // الثقة: مساحة معقولة + تمايز بين الطاولة وما حولها
  const confidence = Math.max(0, Math.min(1, (areaFrac - 0.1) / 0.4)) * (tableCells < cols * rows * 0.97 ? 1 : 0.6);
  return {
    corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
    confidence, tableFraction: tableCells / (cols * rows), areaFraction: areaFrac,
    reference: ref, mask, cols, rows,
  };
}
