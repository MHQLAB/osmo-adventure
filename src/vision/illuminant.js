// تقدير لون الإضاءة من البكسلات المحايدة الساطعة فقط (الأجزاء البيضاء في القطع، قاعدة Osmo، الورق…).
// لون الطاولة لا يدخل في التقدير: طاولة خشبية تحت ضوء أبيض لا تُعدّ «انحرافًا لونيًا».

/**
 * @returns {{gains:[number,number,number], white:[number,number,number], samples:number, reliable:boolean}}
 */
export function estimateIlluminant(rgba, { step = 2, minFraction = 0.002, maxChroma = 0.32 } = {}) {
  // المرور الأول: عتبة السطوع (أعلى ~10%)
  const hist = new Uint32Array(256);
  let n = 0;
  for (let p = 0; p < rgba.length; p += 4 * step) {
    hist[(rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8]++; n++;
  }
  let acc = 0, thr = 255;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.1) { thr = v; break; } }
  thr = Math.max(thr, 90);
  // المرور الثاني: متوسط البكسلات الساطعة منخفضة التشبع وغير المشبعة كليًا
  let r = 0, g = 0, b = 0, k = 0;
  for (let p = 0; p < rgba.length; p += 4 * step) {
    const R = rgba[p], G = rgba[p + 1], B = rgba[p + 2];
    const L = (R * 77 + G * 150 + B * 29) >> 8;
    if (L < thr || R > 250 || G > 250 || B > 250) continue;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    if ((mx - mn) / mx > maxChroma) continue;
    r += R; g += G; b += B; k++;
  }
  const reliable = k >= n * minFraction && k >= 20;
  if (!k) return { gains: [1, 1, 1], white: [0, 0, 0], samples: 0, reliable: false };
  const white = [r / k, g / k, b / k];
  const avg = (white[0] + white[1] + white[2]) / 3;
  return { gains: white.map((c) => avg / c), white, samples: k, reliable };
}

/** مقدار انحراف الإضاءة (0 = أبيض محايد). */
export function illuminantCast(est) {
  if (!est.reliable) return null;
  const [r, g, b] = est.white; const avg = (r + g + b) / 3;
  return Math.max(Math.abs(r - avg), Math.abs(g - avg), Math.abs(b - avg)) / avg;
}

/** يطبق التصحيح (von Kries) في مكانه. */
export function applyGains(rgba, [gr, gg, gb]) {
  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = rgba[p] * gr; rgba[p + 1] = rgba[p + 1] * gg; rgba[p + 2] = rgba[p + 2] * gb;
  }
  return rgba;
}
