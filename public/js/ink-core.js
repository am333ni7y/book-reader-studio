// Pen ink + highlight-kind helpers shared by the server (Node), the stores and the browser SPA.
// Pure ES module: no DOM, no Node imports.
//
// Ink data model (highlight row with kind 'ink'):
//   rects = [ { mode: 'page', aspect }, stroke, ... ]     PDF: strokes normalized to the page (x, y in 0..1);
//                                                          aspect = page height / width (for export)
//   rects = [ { mode: 'epub-anchor', start, end, aspect }, stroke, ... ]
//                                                          EPUB: a handwritten note card anchored to a
//                                                          character offset; strokes normalized to the card
//   stroke = { points: [[x, y, pressure], ...], color, width }
//   width is in thousandths of the drawing surface width (page width or card width).

export const HIGHLIGHT_KINDS = ['text', 'area', 'ink'];
export const HIGHLIGHT_COLORS = ['amber', 'sage', 'sky', 'coral', 'lavender'];
export const INK_COLORS = { black: '#1f1d1a', blue: '#1d4ed8', red: '#dc2626' };
export const INK_WIDTHS = { s: 2.5, m: 4.5, l: 8 };
export const EPUB_CARD_ASPECT = 0.62; // card height / width

export const INK_LIMITS = {
  maxStrokes: 400,
  maxPointsPerStroke: 4000,
  maxTotalPoints: 60000,
};

export function normalizeHighlightKind(kind) {
  return HIGHLIGHT_KINDS.includes(kind) ? kind : 'text';
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const clamp01 = (n) => Math.max(0, Math.min(1, n));

export function inkColorHex(color) {
  if (INK_COLORS[color]) return INK_COLORS[color];
  return /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color) : INK_COLORS.black;
}

function sanitizeColor(color) {
  if (INK_COLORS[color] || HIGHLIGHT_COLORS.includes(color)) return color;
  return /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color).toLowerCase() : 'black';
}

export function sanitizeStroke(stroke, budget = { points: INK_LIMITS.maxTotalPoints }) {
  if (!stroke || typeof stroke !== 'object' || !Array.isArray(stroke.points)) return null;
  const points = [];
  for (const p of stroke.points) {
    if (points.length >= INK_LIMITS.maxPointsPerStroke || budget.points <= 0) break;
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rawP = Number(p[2]);
    const pressure = Number.isFinite(rawP) ? clamp01(rawP) : 0.5;
    points.push([round4(clamp01(x)), round4(clamp01(y)), round4(pressure)]);
    budget.points -= 1;
  }
  if (points.length === 0) return null;
  const width = Number(stroke.width);
  return {
    points,
    color: sanitizeColor(stroke.color),
    width: Number.isFinite(width) ? Math.max(0.5, Math.min(40, round4(width))) : INK_WIDTHS.m,
  };
}

function sanitizeMeta(a) {
  const aspect = Number(a.aspect);
  if (a.mode === 'page') {
    return { mode: 'page', aspect: Number.isFinite(aspect) && aspect > 0.1 && aspect < 10 ? round4(aspect) : 1.414 };
  }
  return sanitizeAnchor(a);
}

function sanitizeAnchor(a) {
  const start = Math.max(0, Math.floor(Number(a.start) || 0));
  const end = Math.max(start, Math.floor(Number(a.end) || start));
  const aspect = Number(a.aspect);
  return {
    mode: 'epub-anchor',
    start,
    end,
    aspect: Number.isFinite(aspect) && aspect > 0.1 && aspect < 4 ? round4(aspect) : EPUB_CARD_ASPECT,
  };
}

// Validates ink rects: returns a clean array, or null when nothing usable is left.
export function sanitizeInkRects(rects) {
  if (!Array.isArray(rects)) return null;
  const out = [];
  const budget = { points: INK_LIMITS.maxTotalPoints };
  rects.forEach((item, i) => {
    if (i === 0 && item && (item.mode === 'epub-anchor' || item.mode === 'page')) {
      out.push(sanitizeMeta(item));
      return;
    }
    if (out.filter((r) => r.points).length >= INK_LIMITS.maxStrokes) return;
    const s = sanitizeStroke(item, budget);
    if (s) out.push(s);
  });
  return out.some((r) => r.points) ? out : null;
}

// Rects for any kind. Text/area rects are passed through unchanged (existing behaviour).
export function sanitizeHighlightRects(kind, rects) {
  if (normalizeHighlightKind(kind) === 'ink') return sanitizeInkRects(rects);
  return Array.isArray(rects) ? rects : [];
}

export function inkStrokes(rects) {
  return Array.isArray(rects) ? rects.filter((r) => r && Array.isArray(r.points)) : [];
}

export function inkPageAspect(rects) {
  const first = Array.isArray(rects) ? rects[0] : null;
  return first && first.mode === 'page' ? first.aspect : 1.414;
}

export function inkAnchor(rects) {
  const first = Array.isArray(rects) ? rects[0] : null;
  return first && first.mode === 'epub-anchor' ? first : null;
}

// Client point -> normalized [x, y, pressure] on a surface rect ({ left, top, width, height }).
// A mouse reports pressure 0.5 while pressed and 0 when not; a pen without pressure support reports 0.5.
export function normalizePoint(clientX, clientY, pressure, rect) {
  const w = rect.width || 1;
  const h = rect.height || 1;
  const p = Number.isFinite(pressure) && pressure > 0 ? pressure : 0.5;
  return [round4(clamp01((clientX - rect.left) / w)), round4(clamp01((clientY - rect.top) / h)), round4(clamp01(p))];
}

// Drops points closer than minDist (normalized units) to the previous kept point; always keeps the last.
export function thinPoints(points, minDist = 0.0015) {
  if (points.length <= 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(points[i][0] - prev[0], points[i][1] - prev[1]) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

// Pressure 0..1 -> width factor 0.4..1.4 (0.5 => 0.9).
export function pressureWidth(baseWidth, pressure) {
  const p = Number.isFinite(pressure) ? clamp01(pressure) : 0.5;
  return baseWidth * (0.4 + p);
}

const fmt = (n) => (Math.round(n * 10) / 10).toString();

// SVG path (filled outline) for a stroke on a surface of `w` x `h` user units.
// Stroke width is in thousandths of w; pressure varies the width along the stroke.
export function strokeOutlinePath(stroke, w, h) {
  const pts = (stroke.points || []).map(([x, y, p]) => [x * w, y * h, (pressureWidth(stroke.width || INK_WIDTHS.m, p) * w) / 1000 / 2]);
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    const [x, y, r] = pts[0];
    return `M${fmt(x - r)} ${fmt(y)}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0Z`;
  }
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const r = pts[i][2];
    left.push([pts[i][0] - dy * r, pts[i][1] + dx * r]);
    right.push([pts[i][0] + dy * r, pts[i][1] - dx * r]);
  }
  const rEnd = pts[pts.length - 1][2];
  const rStart = pts[0][2];
  let d = `M${fmt(left[0][0])} ${fmt(left[0][1])}`;
  for (let i = 1; i < left.length; i++) d += `L${fmt(left[i][0])} ${fmt(left[i][1])}`;
  const lastR = right[right.length - 1];
  d += `A${fmt(rEnd)} ${fmt(rEnd)} 0 0 1 ${fmt(lastR[0])} ${fmt(lastR[1])}`;
  for (let i = right.length - 2; i >= 0; i--) d += `L${fmt(right[i][0])} ${fmt(right[i][1])}`;
  d += `A${fmt(rStart)} ${fmt(rStart)} 0 0 1 ${fmt(left[0][0])} ${fmt(left[0][1])}Z`;
  return d;
}

// Distance (normalized units, x scaled by aspect so circles stay round) from a point to a stroke.
export function strokeDistance(stroke, x, y, aspect = 1) {
  const pts = stroke.points || [];
  let best = Infinity;
  const sy = (v) => v * aspect;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const ax = a[0];
    const ay = sy(a[1]);
    const bx = b[0];
    const by = sy(b[1]);
    const px = x;
    const py = sy(y);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

// Indexes of strokes within `radius` (normalized to surface width) of (x, y).
export function strokesHitBy(strokes, x, y, radius, aspect = 1) {
  const hits = [];
  strokes.forEach((s, i) => {
    const halfWidth = ((s.width || INK_WIDTHS.m) * 1.4) / 1000 / 2;
    if (strokeDistance(s, x, y, aspect) <= radius + halfWidth) hits.push(i);
  });
  return hits;
}

// Standalone SVG markup (for Obsidian export and sidebar thumbnails). `aspect` = height / width.
export function inkToSvg(strokes, { aspect = 1, width = 1000, background = '' } = {}) {
  const w = width;
  const h = Math.max(1, Math.round(width * aspect));
  const paths = strokes
    .map((s) => `<path d="${strokeOutlinePath(s, w, h)}" fill="${inkColorHex(s.color)}"/>`)
    .join('');
  const bg = background ? `<rect width="${w}" height="${h}" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${bg}${paths}</svg>`;
}

// Tight bounding box (normalized) of the strokes, for cropping an export to what was actually written.
export function inkBounds(strokes, pad = 0.02) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const s of strokes) {
    for (const [x, y] of s.points || []) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX) return { x: 0, y: 0, w: 1, h: 1 };
  minX = clamp01(minX - pad);
  minY = clamp01(minY - pad);
  maxX = clamp01(maxX + pad);
  maxY = clamp01(maxY + pad);
  return { x: minX, y: minY, w: Math.max(0.01, maxX - minX), h: Math.max(0.01, maxY - minY) };
}

// Re-maps strokes into their own bounding box so a page sketch exports without the empty page around it.
// `pageAspect` is page height / width; returns { strokes, aspect } for inkToSvg.
export function cropInk(strokes, pageAspect = 1.414) {
  const b = inkBounds(strokes);
  const cropped = strokes.map((s) => ({
    ...s,
    width: (s.width || INK_WIDTHS.m) / b.w,
    points: s.points.map(([x, y, p]) => [(x - b.x) / b.w, (y - b.y) / b.h, p]),
  }));
  return { strokes: cropped, aspect: (b.h * pageAspect) / b.w };
}
