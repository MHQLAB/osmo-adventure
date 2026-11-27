// اقتراح الاتجاه تلقائيًا من هندسة عاكس Osmo، دون انتظار المستخدم.
//
// الاستنتاج (يُتحقق منه بالاختبار المادي):
// - العاكس مرآة واحدة بزاوية ~45°: الأشعة العلوية في صورة الكاميرا ترتد نحو الطاولة قرب الآيباد،
//   والسفلية نحو الطفل. إذن أعلى الإطار = جهة الآيباد، وهو الاتجاه المطلوب (أعلى الشاشة = نحو الآيباد).
// - الانعكاس الواحد يقلب اليمين واليسار ← يلزم عكس أفقي واحد.
// - Safari يسلّم الإطار معتدلًا وفق اتجاه الواجهة، فلا دوران.
// - استثناء: في التطبيق المثبت على iPadOS 26 قد يصل الإطار مدارًا 90° (خلل WebKit 299591).
//   نكتشفه بعدم تطابق شكل الإطار (طولي/عرضي) مع اتجاه الواجهة. اتجاه الـ90° غير معروف بعد ← ثقة منخفضة.

export function suggestOrientation({ vw, vh, orientation }) {
  if (!(vw > 0 && vh > 0)) return null;
  const frameLandscape = vw > vh;
  const uiLandscape = orientation === 'landscape';
  if (frameLandscape === uiLandscape || vw === vh) {
    return { rotation: 0, flipH: true, flipV: false, confidence: 'high', reason: 'frame-matches-ui' };
  }
  return { rotation: 90, flipH: true, flipV: false, confidence: 'low', reason: 'frame-rotated-vs-ui' };
}
