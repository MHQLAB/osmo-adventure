// مقاييس جودة الصورة واستقرار المشهد. وحدة صرفة.

/** يحوّل RGBA إلى سطوع مصغّر بعامل step (يقلل الحساب). */
export function lumaDownsample(rgba, w, h, step = 2) {
  const ow = Math.floor(w / step), oh = Math.floor(h / step);
  const out = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const p = ((y * step) * w + x * step) << 2;
      out[y * ow + x] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    }
  }
  return { data: out, w: ow, h: oh };
}

/** مقاييس: متوسط السطوع، التباين، الحدة (تباين لابلاس)، نسب الإعتام/الإشباع، متوسطات الألوان. */
export function analyze(rgba, w, h, step = 2) {
  const L = lumaDownsample(rgba, w, h, step);
  const n = L.data.length;
  let sum = 0, sq = 0, dark = 0, bright = 0;
  for (let i = 0; i < n; i++) {
    const v = L.data[i];
    sum += v; sq += v * v;
    if (v < 25) dark++; else if (v > 245) bright++;
  }
  const mean = n ? sum / n : 0;
  const contrast = n ? Math.sqrt(Math.max(0, sq / n - mean * mean)) : 0;
  // تباين لابلاس كمؤشر حدة
  let ls = 0, lsq = 0, ln = 0;
  for (let y = 1; y < L.h - 1; y++) {
    for (let x = 1; x < L.w - 1; x++) {
      const i = y * L.w + x;
      const lap = 4 * L.data[i] - L.data[i - 1] - L.data[i + 1] - L.data[i - L.w] - L.data[i + L.w];
      ls += lap; lsq += lap * lap; ln++;
    }
  }
  const lm = ln ? ls / ln : 0;
  const sharpness = ln ? lsq / ln - lm * lm : 0;
  let r = 0, g = 0, b = 0, cn = 0;
  for (let p = 0; p < rgba.length; p += 4 * step * 2) { r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; cn++; }
  return {
    meanLuma: mean,
    contrast,
    sharpness,
    darkPct: n ? (dark / n) * 100 : 0,
    brightPct: n ? (bright / n) * 100 : 0,
    meanRGB: cn ? [r / cn, g / cn, b / cn] : [0, 0, 0],
    luma: L,
  };
}

/** متوسط الفرق المطلق بين إطارين (0–255). */
export function motionScore(prev, cur) {
  if (!prev || prev.length !== cur.length) return Infinity;
  let s = 0;
  for (let i = 0; i < cur.length; i++) s += Math.abs(cur[i] - prev[i]);
  return s / cur.length;
}

/** عتبات أولية — ستُضبط بعد اختبارات الآيباد الفعلية (غير معايرة بعد). */
export const THRESHOLDS = {
  minLuma: 60, maxLuma: 215, minContrast: 25, minSharpness: 40, maxDarkPct: 20, maxBrightPct: 8, maxCast: 0.18,
};

/** يحوّل المقاييس إلى قائمة مشكلات برسائل عربية للوالدين. */
export function assessQuality(m, t = THRESHOLDS) {
  const issues = [];
  if (m.meanLuma < t.minLuma) issues.push({ code: 'dark', level: 'error', msg: 'الإضاءة ضعيفة. أضئ الطاولة أكثر.' });
  if (m.meanLuma > t.maxLuma) issues.push({ code: 'bright', level: 'error', msg: 'الإضاءة قوية جدًا. خفّف الضوء المباشر.' });
  if (m.contrast < t.minContrast) issues.push({ code: 'flat', level: 'warn', msg: 'التباين منخفض. استخدم سطحًا بلون مختلف عن القطع.' });
  if (m.sharpness < t.minSharpness) issues.push({ code: 'blur', level: 'warn', msg: 'الصورة غير حادة. تأكد من تثبيت العاكس ونظافته.' });
  if (m.darkPct > t.maxDarkPct) issues.push({ code: 'shadow', level: 'warn', msg: 'توجد ظلال كبيرة على منطقة اللعب.' });
  if (m.brightPct > t.maxBrightPct) issues.push({ code: 'glare', level: 'warn', msg: 'يوجد لمعان أو انعكاس ضوئي على الطاولة.' });
  const [r, g, b] = m.meanRGB; const avg = (r + g + b) / 3 || 1;
  const cast = Math.max(Math.abs(r - avg), Math.abs(g - avg), Math.abs(b - avg)) / avg;
  if (cast > t.maxCast) issues.push({ code: 'cast', level: 'info', msg: 'الإضاءة ملوّنة. الضوء الأبيض يحسّن تمييز الألوان.' });
  return issues;
}

/**
 * بوابة الاستقرار: لا تعتبر المشهد مستقرًا إلا إذا بقيت الحركة تحت العتبة مدة stableMs.
 * تُستخدم لاحقًا لمنع قراءة الأوامر أثناء تحريك الطفل للقطع.
 */
export class StabilityGate {
  constructor({ threshold = 4, stableMs = 800 } = {}) {
    this.threshold = threshold; this.stableMs = stableMs; this.since = null;
  }
  update(motion, now) {
    if (!(motion <= this.threshold)) { this.since = null; return { stable: false, heldMs: 0 }; }
    if (this.since === null) this.since = now;
    const heldMs = now - this.since;
    return { stable: heldMs >= this.stableMs, heldMs };
  }
  reset() { this.since = null; }
}
