// جدولة تكيفية للمعالجة: تقلل المعدل/الدقة عند بطء الجهاز، وترفعها عند توفر الهامش.

export const QUALITY_LEVELS = [
  { name: 'low', maxSide: 240 },
  { name: 'medium', maxSide: 360 },
  { name: 'high', maxSide: 480 },
];

export class AdaptiveScheduler {
  constructor({ budgetMs = 14, minIntervalMs = 66, maxIntervalMs = 500, level = 1 } = {}) {
    this.budgetMs = budgetMs;
    this.minIntervalMs = minIntervalMs;
    this.maxIntervalMs = maxIntervalMs;
    this.intervalMs = minIntervalMs;
    this.level = level;
    this.last = -Infinity;
    this.avgMs = null;
    this.samples = 0;
  }
  shouldProcess(now) {
    if (now - this.last >= this.intervalMs) { this.last = now; return true; }
    return false;
  }
  /** يسجل زمن معالجة إطار ويعدّل المعدل والمستوى. */
  report(ms) {
    this.avgMs = this.avgMs === null ? ms : this.avgMs * 0.85 + ms * 0.15;
    this.samples++;
    if (this.samples < 5) return;
    if (this.avgMs > this.budgetMs * 1.5) {
      if (this.level > 0) { this.level--; this.samples = 0; this.avgMs = null; }
      else this.intervalMs = Math.min(this.maxIntervalMs, this.intervalMs * 1.25);
    } else if (this.avgMs < this.budgetMs * 0.5) {
      if (this.intervalMs > this.minIntervalMs) this.intervalMs = Math.max(this.minIntervalMs, this.intervalMs / 1.25);
      else if (this.level < QUALITY_LEVELS.length - 1 && this.samples > 30) { this.level++; this.samples = 0; this.avgMs = null; }
    }
  }
  get maxSide() { return QUALITY_LEVELS[this.level].maxSide; }
  /** وضع خامل لتوفير البطارية (مثل: لا تغيير في المشهد لفترة طويلة). */
  setIdle(idle) { this.minIntervalMs = idle ? 250 : 66; if (!idle) this.intervalMs = Math.min(this.intervalMs, 66); }
}
