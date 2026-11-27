// صحة الإطارات: اكتشاف الإطار الأسود والمتجمد وتوقف البث، وسياسة استعادة بلا حلقة لا نهائية. وحدة صرفة.

export class FrameHealth {
  constructor({ blackLuma = 6, blackContrast = 3, blackMs = 800, frozenMs = 1500 } = {}) {
    Object.assign(this, { blackLuma, blackContrast, blackMs, frozenMs });
    this.blackSince = null; this.lastFrameAt = null; this.lastCounter = -1;
  }
  /** يُستدعى عند وصول إطار جديد من الكاميرا (requestVideoFrameCallback أو تقدّم currentTime). */
  frameArrived(now) { this.lastFrameAt = now; }
  /**
   * @param {{now:number, meanLuma:number, contrast:number, trackState?:string, muted?:boolean}} s
   * @returns {{valid:boolean, status:'ok'|'black'|'frozen'|'ended'|'muted'|'starting', ms:number}}
   */
  update({ now, meanLuma, contrast, trackState = 'live', muted = false }) {
    if (trackState === 'ended') return { valid: false, status: 'ended', ms: 0 };
    if (muted) return { valid: false, status: 'muted', ms: 0 };
    if (this.lastFrameAt === null) return { valid: false, status: 'starting', ms: 0 };
    const gap = now - this.lastFrameAt;
    if (gap > this.frozenMs) return { valid: false, status: 'frozen', ms: gap };
    const black = meanLuma < this.blackLuma && contrast < this.blackContrast;
    if (black) { if (this.blackSince === null) this.blackSince = now; } else this.blackSince = null;
    // الإطار الأسود لا يُستخدم أبدًا للمعايرة أو التعرف، حتى قبل اعتباره عطلًا مستمرًا
    if (black) return { valid: false, status: now - this.blackSince >= this.blackMs ? 'black' : 'ok', ms: now - this.blackSince };
    return { valid: true, status: 'ok', ms: 0 };
  }
  reset() { this.blackSince = null; this.lastFrameAt = null; }
}

/**
 * سياسة الاستعادة: محاولات بتأخير متزايد، ثم توقف ورسالة للوالدين بدل حلقة إعادة تشغيل.
 * النجاح المستمر (stableMs) يعيد العداد.
 */
export class RecoveryPolicy {
  constructor({ delays = [0, 2000, 8000], windowMs = 120000 } = {}) {
    this.delays = delays; this.windowMs = windowMs; this.attempts = [];
  }
  next(now) {
    this.attempts = this.attempts.filter((t) => now - t < this.windowMs);
    if (this.attempts.length >= this.delays.length) return { action: 'give-up', attempts: this.attempts.length };
    const delayMs = this.delays[this.attempts.length];
    this.attempts.push(now + delayMs);
    return { action: 'restart', delayMs, attempt: this.attempts.length };
  }
  succeeded() { this.attempts = []; }
}
