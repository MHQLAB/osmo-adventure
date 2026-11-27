// قراءة اتجاه السهم على القرص الرمادي. وحدة صرفة.
// الطريقة: نعزل مكوّن السهم الداكن قرب القرص، نحسب محوره الرئيسي، ثم الرأس = النصف الأعرض
// (الرأس مثلث عريض والساق رفيعة). لا تعتمد على دقة مركز القرص، وتصحح المركز نفسه.
// الاتجاه بإحداثيات الصورة المصححة: أعلى = نحو الآيباد.

export const DIRS = ['right', 'down', 'left', 'up']; // زوايا 0، 90، 180، 270 (y للأسفل)

export function readArrow(labels, val, w, h, dial, inkLabel = 9, sat = null) {
  const R = dial.r * 1.5;
  const x0 = Math.max(0, Math.floor(dial.cx - R)), x1 = Math.min(w - 1, Math.ceil(dial.cx + R));
  const y0 = Math.max(0, Math.floor(dial.cy - R)), y1 = Math.min(h - 1, Math.ceil(dial.cy + R));
  const ww = x1 - x0 + 1, hh = y1 - y0 + 1;
  if (ww < 6 || hh < 6) return { ok: false, reason: 'tiny' };
  // مستوى الإضاءة المحلي من البكسلات الفاتحة (القرص)
  const lv = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; if (!sat || sat[i] < 0.25) lv.push(val[i]); }
  if (lv.length < 20) return { ok: false, reason: 'no-disc' };
  lv.sort((a, b) => a - b);
  const light = lv[Math.floor(lv.length * 0.8)];
  const dark = new Uint8Array(ww * hh);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * w + x;
    if ((labels[i] === inkLabel || val[i] < light * 0.55) && (!sat || sat[i] < 0.45)) dark[(y - y0) * ww + (x - x0)] = 1;
  }
  // أكبر مكوّن داكن قريب من مركز القرص ولا يلامس حدود النافذة (يستبعد ظلال الحواف)
  const seen = new Uint8Array(ww * hh); let best = null, bestScore = 0;
  const lcx = dial.cx - x0, lcy = dial.cy - y0;
  for (let i = 0; i < ww * hh; i++) {
    if (!dark[i] || seen[i]) continue;
    const comp = []; const st = [i]; seen[i] = 1; let touches = false;
    while (st.length) {
      const j = st.pop(); comp.push(j); const x = j % ww, y = (j / ww) | 0;
      if (x === 0 || y === 0 || x === ww - 1 || y === hh - 1) touches = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= ww || ny >= hh) continue;
        const k = ny * ww + nx; if (dark[k] && !seen[k]) { seen[k] = 1; st.push(k); }
      }
    }
    if (touches || comp.length < 10) continue;
    let mx = 0, my = 0; for (const j of comp) { mx += j % ww; my += (j / ww) | 0; } mx /= comp.length; my /= comp.length;
    const d = Math.hypot(mx - lcx, my - lcy) / dial.r;
    if (d > 0.9) continue;
    const score = comp.length * (1 - d * 0.6);
    if (score > bestScore) { bestScore = score; best = comp; }
  }
  if (!best) return { ok: false, reason: 'no-ink' };
  const pts = best.map((j) => [(j % ww) + x0, ((j / ww) | 0) + y0]);
  let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
  let a = 0, b = 0, c = 0; for (const [x, y] of pts) { const dx = x - mx, dy = y - my; a += dx * dx; b += dy * dy; c += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * c, a - b);
  const ux = Math.cos(theta), uy = Math.sin(theta);
  let tmin = Infinity, tmax = -Infinity;
  const proj = pts.map(([x, y]) => { const t = (x - mx) * ux + (y - my) * uy, s = -(x - mx) * uy + (y - my) * ux; if (t < tmin) tmin = t; if (t > tmax) tmax = t; return [t, s]; });
  const mid = (tmin + tmax) / 2;
  // عرض كل نصف: متوسط |s| لأبعد البكسلات (الربع الأعلى) — الرأس أعرض بوضوح
  const spread = (sel) => { const v = proj.filter(sel).map(([, s]) => Math.abs(s)).sort((p, q) => q - p); const k = Math.max(1, Math.floor(v.length / 4)); let sum = 0; for (let i = 0; i < k; i++) sum += v[i] || 0; return sum / k; };
  const sPos = spread(([t]) => t > mid), sNeg = spread(([t]) => t <= mid);
  const ratio = Math.max(sPos, sNeg) / Math.max(0.5, Math.min(sPos, sNeg));
  const sign = sPos >= sNeg ? 1 : -1;
  const angle = (Math.atan2(uy * sign, ux * sign) * 180 / Math.PI + 360) % 360;
  const q = Math.round(angle / 90) % 4;
  const dev = Math.abs(((angle - q * 90 + 540) % 360) - 180);
  const length = tmax - tmin;
  const elong = Math.sqrt(Math.max(a, b) / Math.max(1e-6, Math.min(a, b)));
  let confidence = Math.min(1, (ratio - 1) / 0.6) * Math.max(0, 1 - Math.max(0, dev - 15) / 25) * Math.min(1, (elong - 1) / 0.5) * (length > dial.r * 0.6 ? 1 : 0.5);
  confidence = Math.max(0, Math.min(1, confidence));
  return {
    ok: true, dir: DIRS[q], angle: Math.round(angle), deviation: Math.round(dev), confidence: +confidence.toFixed(2),
    headRatio: +ratio.toFixed(2), center: [+(mx + ux * ((tmin + tmax) / 2)).toFixed(1), +(my + uy * ((tmin + tmax) / 2)).toFixed(1)],
  };
}
