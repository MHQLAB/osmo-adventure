// مولّد مشاهد اصطناعية لقطع تشبه Osmo هندسيًا (أشكال أصلية مبسطة، ليست أصول Osmo).
// لاختبار المحرك آليًا بإجابات معروفة — ليست بديلًا عن صور القطع الحقيقية.
import sharp from 'sharp';

const COLORS = { walk: '#1076a0', jump: '#c5213a', hand: '#e56f42', rest: '#302a55', magic: '#a84c8c', function: '#3a9888', repeat: '#a9acaa', number: '#c8921a' };
const DIR_DEG = { right: 0, down: 90, left: 180, up: 270 };

function arrowSvg(cx, cy, r, dir) {
  const a = DIR_DEG[dir];
  return `<g transform="translate(${cx} ${cy}) rotate(${a})"><rect x="${-r * 0.55}" y="${-r * 0.11}" width="${r * 0.7}" height="${r * 0.22}" fill="#3c3f42"/><polygon points="${r * 0.62},0 ${r * 0.1},${-r * 0.42} ${r * 0.1},${r * 0.42}" fill="#3c3f42"/></g>`;
}

function iconSvg(kind, s) {
  if (kind === 'circle') return `<circle r="${s * 0.42}" fill="none" stroke="#e8f4f0" stroke-width="${s * 0.1}"/><circle r="${s * 0.18}" fill="#e8f4f0"/>`;
  if (kind === 'square') return `<rect x="${-s * 0.4}" y="${-s * 0.4}" width="${s * 0.8}" height="${s * 0.8}" fill="none" stroke="#e8f4f0" stroke-width="${s * 0.1}"/><rect x="${-s * 0.17}" y="${-s * 0.17}" width="${s * 0.34}" height="${s * 0.34}" fill="#e8f4f0"/>`;
  const pts = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.2 : s * 0.48; const t = (Math.PI / 5) * i - Math.PI / 2; pts.push(`${r * Math.cos(t)},${r * Math.sin(t)}`); }
  return `<polygon points="${pts.join(' ')}" fill="none" stroke="#e8f4f0" stroke-width="${s * 0.08}"/>`;
}

/**
 * قطعة: {type, x, y, angle (درجات، محور القطعة), dir?, icon?, digit?}
 * الطول L=4.2u والعرض W=1.8u حيث u = unit.
 */
export function pieceSvg(p, u) {
  const Lh = 2.1 * u, Wh = 0.9 * u;
  if (p.type === 'number') {
    return `<g transform="translate(${p.x} ${p.y}) rotate(${p.angle || 0})"><path d="M ${-1.1 * u} ${-0.9 * u} L ${1.1 * u} ${-0.9 * u} L ${1.1 * u} ${0.9 * u} L ${0.55 * u} ${0.9 * u} A ${0.6 * u} ${0.6 * u} 0 0 0 ${-0.55 * u} ${0.9 * u} L ${-1.1 * u} ${0.9 * u} Z" fill="${COLORS.number}"/><text x="0" y="${0.35 * u}" font-family="DejaVu Sans" font-weight="bold" font-size="${1.05 * u}" text-anchor="middle" fill="#3a3a3a" transform="rotate(${p.digitAngle || 0} 0 0)">${p.digit}</text></g>`;
  }
  let inner = '';
  if (['walk', 'jump', 'hand'].includes(p.type)) {
    inner += `<rect x="${-Lh * 0.45}" y="${-u * 0.3}" width="${u * 0.6}" height="${u * 0.6}" rx="${u * 0.1}" fill="#f4f4f4"/>`; // أيقونة بيضاء مبسطة
    inner += `<circle cx="${Lh * 0.5}" cy="0" r="${0.78 * u}" fill="#c0c3c5"/>`;
  } else if (p.type === 'function') {
    inner += `<g>${iconSvg(p.icon, 1.3 * u)}</g>`;
  } else if (p.type === 'repeat') {
    inner += `<rect x="${-u * 0.9}" y="${-u * 0.45}" width="${u * 1.8}" height="${u * 0.9}" rx="${u * 0.2}" fill="none" stroke="#333" stroke-width="${u * 0.14}"/>`;
  } else if (p.type === 'magic') {
    inner += `<polygon points="0,${-u * 0.4} ${u * 0.12},${-u * 0.1} ${u * 0.4},${-u * 0.1} ${u * 0.17},${u * 0.08} ${u * 0.26},${u * 0.38} 0,${u * 0.2} ${-u * 0.26},${u * 0.38} ${-u * 0.17},${u * 0.08} ${-u * 0.4},${-u * 0.1} ${-u * 0.12},${-u * 0.1}" fill="#f6e6f0"/>`;
  } else if (p.type === 'rest') {
    inner += `<text x="0" y="${u * 0.35}" font-family="DejaVu Sans" font-weight="bold" font-size="${u}" text-anchor="middle" fill="#f0f0f8">Z</text>`;
  }
  const body = `<g transform="translate(${p.x} ${p.y}) rotate(${p.angle || 0})"><rect x="${-Lh}" y="${-Wh}" width="${2 * Lh}" height="${2 * Wh}" rx="${0.35 * u}" fill="${COLORS[p.type]}"/>${inner}</g>`;
  const arrow = p.dir ? (() => { const t = ((p.angle || 0) * Math.PI) / 180; return arrowSvg(p.x + Math.cos(t) * Lh * 0.5, p.y + Math.sin(t) * Lh * 0.5, 0.78 * u, p.dir); })() : '';
  return body + arrow;
}

export async function renderScene({ w = 640, h = 480, u = 22, pieces = [], bg = '#b98446', grain = true }) {
  let grainSvg = '';
  if (grain) for (let i = 0; i < 40; i++) { const y = (i * 37) % h; grainSvg += `<path d="M0 ${y} Q ${w / 2} ${y + ((i * 13) % 9) - 4} ${w} ${y + 3}" stroke="#a87638" stroke-width="2" opacity="0.5" fill="none"/>`; }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${bg}"/>${grainSvg}${pieces.map((p) => pieceSvg(p, u)).join('')}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height, svg };
}
