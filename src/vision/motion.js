// قياس الحركة بالخلايا داخل منطقة اللعب فقط.
// - يزيل التغير العام في السطوع (تعديل التعريض التلقائي) فلا يُحسب حركة.
// - يتجاهل هامشًا ضيقًا عند الحواف (اهتزاز الحدود).
// - يفرق بين حركة موضعية (يد/قطعة) وتغير شامل للإطار (Center Stage، تغير إضاءة الغرفة).

export class CellMotion {
  constructor({ cols = 16, rows = 9, cellThreshold = 10, marginCells = 0, globalFraction = 0.6 } = {}) {
    Object.assign(this, { cols, rows, cellThreshold, marginCells, globalFraction });
    this.prev = null; this.prevW = 0; this.prevH = 0;
  }
  reset() { this.prev = null; }

  /**
   * @param {Uint8Array} luma صورة سطوع (عادة مخرج lumaDownsample للمنطقة المقوّمة)
   * @returns {{changed:number, fraction:number, global:boolean, maxDiff:number, cells:Float32Array|null}}
   */
  update(luma, w, h) {
    if (!this.prev || this.prevW !== w || this.prevH !== h) {
      this.prev = luma.slice(); this.prevW = w; this.prevH = h;
      return { changed: Infinity, fraction: 1, global: false, maxDiff: Infinity, cells: null };
    }
    const n = w * h;
    // الإزاحة العامة = وسيط الفروق (يحذف تغير التعريض المنتظم)
    const hist = new Uint32Array(511);
    for (let i = 0; i < n; i += 3) hist[luma[i] - this.prev[i] + 255]++;
    let half = Math.ceil(n / 3 / 2), acc = 0, offset = 0;
    for (let v = 0; v < 511; v++) { acc += hist[v]; if (acc >= half) { offset = v - 255; break; } }

    const { cols, rows, marginCells: m } = this;
    const sums = new Float32Array(cols * rows), counts = new Uint32Array(cols * rows);
    for (let y = 0; y < h; y++) {
      const cy = Math.min(rows - 1, (y * rows / h) | 0);
      for (let x = 0; x < w; x++) {
        const cx = Math.min(cols - 1, (x * cols / w) | 0);
        const i = y * w + x, c = cy * cols + cx;
        sums[c] += Math.abs(luma[i] - this.prev[i] - offset); counts[c]++;
      }
    }
    let changed = 0, considered = 0, maxDiff = 0;
    const flags = new Uint8Array(cols * rows);
    for (let cy = m; cy < rows - m; cy++) for (let cx = m; cx < cols - m; cx++) {
      const c = cy * cols + cx; const d = counts[c] ? sums[c] / counts[c] : 0;
      sums[c] = d; considered++;
      if (d > maxDiff) maxDiff = d;
      if (d > this.cellThreshold) { changed++; flags[c] = 1; }
    }
    this.prev = luma.slice();
    const fraction = considered ? changed / considered : 0;
    return { changed, fraction, global: fraction >= this.globalFraction, maxDiff, offset, cells: sums, flags };
  }
}

/**
 * خلايا متذبذبة باستمرار (انعكاس الشاشة في المرآة، وميض إضاءة) بينما بقية المنطقة ساكنة.
 * تُستبعد من قرار الثبات بعد ملاحظتها مدة كافية، وتُعرض في التشخيص. يد تدخل وتخرج لا تُستبعد لأنها لا تستمر.
 */
export class FlickerMask {
  constructor({ cells, window = 45, ratio = 0.6, maxMasked = 0.15 } = {}) {
    this.cells = cells; this.window = window; this.ratio = ratio; this.maxMasked = maxMasked;
    this.hist = []; this.mask = new Uint8Array(cells);
  }
  reset() { this.hist = []; this.mask.fill(0); }
  /** changedFlags: Uint8Array لكل خلية (1 = تغيرت في هذا الإطار). يعيد عدد الخلايا المتغيرة بعد الاستبعاد. */
  update(changedFlags) {
    this.hist.push(changedFlags); if (this.hist.length > this.window) this.hist.shift();
    if (this.hist.length >= this.window) {
      const counts = new Uint16Array(this.cells);
      for (const f of this.hist) for (let i = 0; i < this.cells; i++) counts[i] += f[i];
      const cand = []; for (let i = 0; i < this.cells; i++) if (counts[i] >= this.ratio * this.window) cand.push(i);
      // إن تغيرت مساحة كبيرة باستمرار فهي حركة حقيقية/مشكلة عامة لا وميض موضعي
      this.mask.fill(0); if (cand.length <= this.maxMasked * this.cells) for (const i of cand) this.mask[i] = 1;
    }
    let changed = 0; for (let i = 0; i < this.cells; i++) if (changedFlags[i] && !this.mask[i]) changed++;
    return changed;
  }
  get maskedCount() { let n = 0; for (const v of this.mask) n += v; return n; }
}
