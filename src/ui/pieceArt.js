// رسوم توضيحية مبسطة أصلية للقطع (ليست أصول Osmo) لتعليمات الاختبار الموجّه.
const COL = { walk: '#2196d3', jump: '#ef4146', hand: '#f07a3a', rest: '#34306b', magic: '#a04c8c', 'func-circle': '#3fb5a3', 'func-square': '#3fb5a3', 'func-star': '#3fb5a3', repeat: '#b4b7b9' };
const NUM = { n2: '٢', n3: '٣', n4: '٤', n5: '٥' };

function piece(type, y) {
  if (NUM[type]) return `<g transform="translate(190 ${y})"><rect x="0" y="-16" width="34" height="32" rx="9" fill="#f6b51b"/><text x="17" y="8" font-size="20" text-anchor="middle" fill="#333" font-family="sans-serif">${NUM[type]}</text></g>`;
  const dial = ['walk', 'jump', 'hand'].includes(type) ? `<circle cx="150" cy="0" r="15" fill="#c9ccce"/><path d="M150 9 V-8 M143 -2 L150 -9 L157 -2" stroke="#444" stroke-width="3" fill="none"/>` : '';
  const icon = type === 'func-circle' ? '<circle cx="95" cy="0" r="9" fill="none" stroke="#fff" stroke-width="3"/>' : type === 'rest' ? '<text x="95" y="7" fill="#fff" font-size="18" text-anchor="middle" font-family="sans-serif">Z</text>' : type === 'magic' ? '<text x="95" y="7" fill="#fff" font-size="16" text-anchor="middle">✦</text>' : '<rect x="85" y="-8" width="16" height="16" rx="3" fill="#fff" opacity=".9"/>';
  return `<g transform="translate(20 ${y})"><rect x="0" y="-17" width="170" height="34" rx="12" fill="${COL[type] || '#888'}"/>${icon}${dial}</g>`;
}

/** SVG: القطع مرتبة رأسيًا (الأولى أقرب للآيباد في الأعلى). الأرقام تُرسم بجانب القطعة السابقة. */
export function stepArt(types) {
  let y = 34; const parts = [`<text x="120" y="14" font-size="11" text-anchor="middle" fill="#a9b3d6" font-family="sans-serif">▲ جهة الآيباد</text>`];
  let lastY = y;
  for (const t of types) {
    if (NUM[t]) { parts.push(piece(t, lastY)); continue; }
    parts.push(piece(t, y)); lastY = y; y += 38;
  }
  if (!types.length) parts.push('<text x="120" y="60" font-size="14" text-anchor="middle" fill="#a9b3d6" font-family="sans-serif">(سطح فارغ)</text>');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 ${Math.max(90, y + 10)}" width="240">${parts.join('')}</svg>`;
}
