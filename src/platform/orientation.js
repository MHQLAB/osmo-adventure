// اكتشاف اتجاه الجهاز ومتابعة تغيّره.

export function getOrientation(win = globalThis) {
  const t = win.screen?.orientation?.type;
  if (t) return t.startsWith('portrait') ? 'portrait' : 'landscape';
  if (win.matchMedia) return win.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape';
  return (win.innerHeight || 0) >= (win.innerWidth || 0) ? 'portrait' : 'landscape';
}

/** يستدعي cb عند تغيّر الاتجاه فعليًا (مع إزالة الارتداد). يعيد دالة إلغاء الاشتراك. */
export function onOrientationChange(cb, win = globalThis, debounceMs = 250) {
  let current = getOrientation(win);
  let timer = null;
  const check = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const next = getOrientation(win);
      if (next !== current) { const prev = current; current = next; cb(next, prev); }
    }, debounceMs);
  };
  const mq = win.matchMedia?.('(orientation: portrait)');
  mq?.addEventListener?.('change', check);
  win.addEventListener?.('resize', check);
  win.screen?.orientation?.addEventListener?.('change', check);
  return () => {
    mq?.removeEventListener?.('change', check);
    win.removeEventListener?.('resize', check);
    win.screen?.orientation?.removeEventListener?.('change', check);
    clearTimeout(timer);
  };
}
