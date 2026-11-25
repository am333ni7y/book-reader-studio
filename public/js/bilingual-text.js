// Smart Bilingual (Persian RTL + English LTR) Text & Metadata Reconstruction Engine

export const RTL_CHAR_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const RTL_GLOBAL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_GLOBAL_RE = /[A-Za-z]/g;
const PRES_FORM_RE = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;
const MIRROR_BRACKET_MAP = {
  '(': ')', ')': '(',
  '[': ']', ']': '[',
  '{': '}', '}': '{',
  '<': '>', '>': '<',
  '«': '»', '»': '«',
};

function fixVisualRtlBrackets(token, itemDir) {
  if (itemDir === 'rtl' || /[A-Za-z]/.test(token)) return token;
  return token.replace(/[()[\]{}<>«»]/g, (ch) => MIRROR_BRACKET_MAP[ch] || ch);
}

/**
 * Normalizes Arabic Presentation Forms (U+FB50-U+FEFF) and Arabic/Persian
 * character variants into clean standard Persian/Arabic Unicode text.
 */
export function normalizePersianText(str) {
  if (!str) return '';
  return str
    .normalize('NFKC')
    .replace(/\u064A/g, '\u06CC') // Arabic Yeh -> Persian Yeh
    .replace(/\u0643/g, '\u06A9') // Arabic Kaf -> Persian Kaf
    .replace(/\u06C0/g, '\u0647\u0654')
    .replace(/\u200B|\uFEFF/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function countMatches(str, regex) {
  const m = str.match(regex);
  return m ? m.length : 0;
}

/**
 * Reconstructs spatially accurate lines & fullText from PDF.js TextContent,
 * handling both English LTR spans and Persian RTL Presentation-Form glyph runs.
 */
export function reconstructPageText(textContent) {
  const rawItems = (textContent?.items || []).filter(
    (it) => typeof it.str === 'string' && it.str.length > 0
  );
  if (rawItems.length === 0) {
    return { fullText: '', lines: [], dominantDir: 'ltr' };
  }

  const mapped = rawItems.map((it) => {
    const tr = it.transform || [1, 0, 0, 1, 0, 0];
    const fontSize = Math.max(6, it.height || Math.abs(tr[3]) || Math.abs(tr[0]) || 12);
    return {
      str: it.str,
      dir: it.dir || 'ltr',
      x: tr[4] || 0,
      y: tr[5] || 0,
      w: Math.max(0, it.width || 0),
      fontSize,
    };
  });

  // Sort top-to-bottom (higher PDF Y = higher on page)
  mapped.sort((a, b) => b.y - a.y);

  // Group into horizontal lines
  const lines = [];
  for (const item of mapped) {
    const tol = Math.max(3, item.fontSize * 0.45);
    let targetLine = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
      if (Math.abs(lines[i].y - item.y) <= tol) {
        targetLine = lines[i];
        break;
      }
    }
    if (!targetLine) {
      targetLine = { y: item.y, items: [] };
      lines.push(targetLine);
    }
    targetLine.items.push(item);
  }

  let totalRtl = 0;
  let totalLatin = 0;
  const textLines = [];

  for (const line of lines) {
    const lineRaw = line.items.map((i) => i.str).join('');
    const rtlCount = countMatches(lineRaw, RTL_GLOBAL_RE);
    const latinCount = countMatches(lineRaw, LATIN_GLOBAL_RE);
    totalRtl += rtlCount;
    totalLatin += latinCount;

    const lineDir = rtlCount > latinCount * 0.4 ? 'rtl' : 'ltr';

    if (lineDir === 'ltr') {
      line.items.sort((a, b) => a.x - b.x);
      let out = '';
      let prev = null;
      for (const cur of line.items) {
        if (prev && out && !out.endsWith(' ') && !cur.str.startsWith(' ')) {
          const gap = cur.x - (prev.x + prev.w);
          if (gap > cur.fontSize * 0.16 && !out.endsWith('-')) {
            out += ' ';
          }
        }
        out += cur.str;
        prev = cur;
      }
      const clean = out.replace(/[ \t]{2,}/g, ' ').trim();
      if (clean) textLines.push(clean);
    } else {
      // Visual RTL order: sort X descending (right-to-left)
      line.items.sort((a, b) => b.x - a.x);
      let out = '';
      let prev = null;
      for (const cur of line.items) {
        let token = cur.str;
        // If single item holds >2 Presentation-Form chars in visual LTR order
        if (cur.dir !== 'rtl' && token.length > 2 && PRES_FORM_RE.test(token)) {
          token = Array.from(token).reverse().join('');
        }
        token = fixVisualRtlBrackets(token, cur.dir);
        if (prev && out && !out.endsWith(' ') && !token.startsWith(' ')) {
          const gap = prev.x - (cur.x + cur.w);
          if (gap > cur.fontSize * 0.18) {
            out += ' ';
          }
        }
        out += token;
        prev = cur;
      }
      const clean = normalizePersianText(out);
      if (clean) textLines.push(clean);
    }
  }

  const dominantDir = totalRtl > totalLatin * 0.35 ? 'rtl' : 'ltr';
  return {
    fullText: textLines.join('\n'),
    lines: textLines,
    dominantDir,
  };
}

/**
 * Extracts clean, properly ordered text from a DOM Selection Range inside .textLayer.
 */
export function extractCleanSelectionText(range, shell) {
  const fallback = () => normalizePersianText(range.toString().replace(/\s+/g, ' ').trim());
  if (!range || !shell) return fallback();

  const textLayer = shell.querySelector('.textLayer');
  if (!textLayer) return fallback();

  const spans = Array.from(textLayer.querySelectorAll('span')).filter((sp) => {
    if (!sp.textContent) return false;
    try {
      return range.intersectsNode(sp);
    } catch {
      return false;
    }
  });

  if (spans.length === 0) return fallback();

  const combinedRaw = spans.map((s) => s.textContent).join('');
  if (!RTL_CHAR_RE.test(combinedRaw)) {
    return range.toString().replace(/\s+/g, ' ').trim();
  }

  const pieces = [];
  for (const sp of spans) {
    let text = sp.textContent;
    if (sp.firstChild && sp.firstChild.nodeType === Node.TEXT_NODE) {
      if (sp.firstChild === range.startContainer && sp.firstChild === range.endContainer) {
        text = text.slice(range.startOffset, range.endOffset);
      } else if (sp.firstChild === range.startContainer) {
        text = text.slice(range.startOffset);
      } else if (sp.firstChild === range.endContainer) {
        text = text.slice(0, range.endOffset);
      }
    }
    if (!text) continue;
    const rect = sp.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    pieces.push({
      str: text,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      height: Math.max(8, rect.height),
    });
  }

  if (pieces.length === 0) return fallback();

  // Sort top-to-bottom (DOM Y increases downward)
  pieces.sort((a, b) => a.top - b.top);
  const lines = [];
  for (const p of pieces) {
    const tol = p.height * 0.5;
    let line = lines.find((l) => Math.abs(l.top - p.top) <= tol);
    if (!line) {
      line = { top: p.top, items: [] };
      lines.push(line);
    }
    line.items.push(p);
  }

  const outLines = lines.map((line) => {
    const raw = line.items.map((i) => i.str).join('');
    const rtl = countMatches(raw, RTL_GLOBAL_RE);
    const lat = countMatches(raw, LATIN_GLOBAL_RE);
    const isRtl = rtl >= lat;
    line.items.sort((a, b) => (isRtl ? b.left - a.left : a.left - b.left));

    let joined = '';
    let prev = null;
    for (const cur of line.items) {
      let pieceStr = cur.str;
      if (isRtl && !LATIN_GLOBAL_RE.test(pieceStr) && /^[()[\]{}<>«»\s]+$/.test(pieceStr)) {
        pieceStr = fixVisualRtlBrackets(pieceStr, 'ltr');
      }
      if (prev && joined && !joined.endsWith(' ') && !pieceStr.startsWith(' ')) {
        const gap = isRtl ? prev.left - cur.right : cur.left - prev.right;
        if (gap > cur.height * 0.2) joined += ' ';
      }
      joined += pieceStr;
      prev = cur;
    }
    return isRtl ? normalizePersianText(joined) : joined.replace(/\s+/g, ' ').trim();
  });

  return outLines.filter(Boolean).join('\n');
}

export function formatFaNum(n) {
  return new Intl.NumberFormat('fa-IR').format(Number(n) || 0);
}
