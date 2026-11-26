// Single source of truth for Obsidian note generation.
// Pure ES module: no DOM, no Node imports. Used by server.mjs (Node) and public/js/client-backend.js (browser).
import { inkStrokes, inkAnchor, inkPageAspect, cropInk, inkToSvg } from './ink-core.js';

export const OBSIDIAN_START = '<!-- ketabkhan:start -->';
export const OBSIDIAN_END = '<!-- ketabkhan:end -->';

export function sanitizeFilename(name) {
  return String(name || 'book')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'book';
}

// Unique per book: two books with the same title get different names via the id prefix.
export function obsidianFilename(book) {
  return `${sanitizeFilename(book.title)} - ${String(book.id).slice(0, 8)}.md`;
}

// Escapes a value for a double-quoted YAML scalar on a single line.
function yamlString(value) {
  return String(value ?? '').replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '\\"');
}

// Merges a freshly generated note into an existing file, keeping user text outside the managed block.
export function mergeObsidianNote(existingText, newFrontmatter, newBody) {
  const existing = typeof existingText === 'string' ? existingText : '';
  const bodyText = String(newBody || '');
  const block = `${OBSIDIAN_START}\n${bodyText}${bodyText.endsWith('\n') ? '' : '\n'}${OBSIDIAN_END}`;
  const startIdx = existing.indexOf(OBSIDIAN_START);
  const endIdx = existing.indexOf(OBSIDIAN_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return `${newFrontmatter}${block}\n`;
  }
  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(existing);
  let fmEnd = fmMatch ? fmMatch[0].length : 0;
  if (fmEnd > startIdx) fmEnd = 0;
  const userBefore = existing.slice(fmEnd, startIdx);
  const userAfter = existing.slice(endIdx + OBSIDIAN_END.length);
  return `${newFrontmatter}${userBefore}${block}${userAfter}`;
}

// data: { book, bookmarks, highlights, tocEntries } (the shape returned by getBookFull / getBook).
export function buildObsidianParts(data) {
  const { book } = data;
  const bookmarks = data.bookmarks || [];
  const highlights = data.highlights || [];
  const tocEntries = data.tocEntries || [];
  const isEpub = book.format === 'epub';
  const unitLabel = isEpub ? 'فصل' : 'صفحه';
  const pct = book.total_pages > 0 ? Math.round((book.current_page / book.total_pages) * 100) : 0;
  const readingMins = Math.round((book.reading_seconds || 0) / 60);
  const colorLabels = {
    amber: '🟡 نکته کلیدی (Amber)',
    sage: '🟢 تایید / کاربردی (Sage)',
    sky: '🔵 مرجع / تعریف (Sky)',
    coral: '🔴 نقد / مهم (Coral)',
    lavender: '🟣 ایده / پرسش (Lavender)',
  };

  const frontmatterLines = [
    '---',
    `title: "${yamlString(book.title)}"`,
    `author: "${yamlString(book.author)}"`,
    `format: "${book.format || 'pdf'}"`,
    `total_${isEpub ? 'chapters' : 'pages'}: ${book.total_pages || 0}`,
    `current_${isEpub ? 'chapter' : 'page'}: ${book.current_page || 1}`,
    `progress: "${pct}%"`,
    `reading_minutes: ${readingMins}`,
    `last_read: "${book.last_opened_at}"`,
    'tags:',
    '  - reading-notes',
    '  - book-reader-studio',
    '---',
  ];

  const lines = [
    '',
    `# ${book.title}`,
    '',
    `- **پیشرفت مطالعه:** ${unitLabel} ${book.current_page} از ${book.total_pages || '?'} (${pct}%)`,
    `- **مدت مطالعه ثبت‌شده:** ${readingMins} دقیقه`,
    '',
  ];

  if (tocEntries.length > 0) {
    lines.push('## فهرست سفارشی ثبت‌شده', '');
    for (const item of tocEntries) {
      const indent = '  '.repeat(Math.max(0, Number(item.level) || 0));
      lines.push(`${indent}- **${item.title}** — ${unitLabel} ${item.page}`);
    }
    lines.push('');
  }

  const pins = bookmarks.filter((b) => b.kind === 'pin');
  const ribbons = bookmarks.filter((b) => b.kind === 'ribbon');

  if (pins.length > 0 || ribbons.length > 0) {
    lines.push('## نشان‌ها و بخش‌های کلیدی', '');
    for (const pin of pins) {
      lines.push(`- 📌 **${unitLabel} ${pin.page}** — \`${pin.category || 'کلیدی'}\` ${pin.label ? `**${pin.label}**` : ''}`);
      if (pin.note) lines.push(`  - یادداشت: ${pin.note}`);
    }
    if (ribbons.length > 0) {
      lines.push(`- 🔖 **بوکمارک‌های سریع:** ${unitLabel}های ${ribbons.map((r) => r.page).join('، ')}`);
    }
    lines.push('');
  }

  lines.push('## هایلایت‌ها و یادداشت‌ها', '');
  if (highlights.length === 0) {
    lines.push('_هنوز هایلایتی برای این کتاب ثبت نشده است._', '');
  } else {
    let lastPage = -1;
    for (const hl of highlights) {
      if (hl.page !== lastPage) {
        lines.push(`### ${unitLabel} ${hl.page}`, '');
        lastPage = hl.page;
      }
      if (hl.kind === 'ink') {
        lines.push(...inkNoteLines(hl, unitLabel), '');
        continue;
      }
      const badge = colorLabels[hl.color] || hl.color;
      const modeTag = hl.kind === 'area' ? ' `[ناحیه‌ای]`' : '';
      if (hl.quote_text && hl.quote_text.trim()) {
        lines.push(`> ${hl.quote_text.trim().replace(/\n+/g, '\n> ')}`, '');
      } else {
        lines.push(`> _[هایلایت تصویری/ناحیه‌ای در ${unitLabel} ${hl.page}]_`, '');
      }
      lines.push(`- **دسته:** ${badge}${modeTag}`);
      if (hl.note && hl.note.trim()) {
        lines.push(`- **یادداشت:** ${hl.note.trim()}`);
      }
      lines.push('');
    }
  }

  return {
    frontmatter: `${frontmatterLines.join('\n')}\n`,
    body: lines.join('\n'),
  };
}

// A handwritten note becomes an inline SVG (Obsidian renders raw SVG in reading view) plus a text line,
// so the note stays findable even where SVG is not rendered.
function inkNoteLines(hl, unitLabel) {
  const strokes = inkStrokes(hl.rects);
  const anchor = inkAnchor(hl.rects);
  const lines = [];
  const where = anchor ? `کنار متن در ${unitLabel} ${hl.page}` : `روی ${unitLabel} ${hl.page}`;
  lines.push(`- ✍️ **یادداشت دست‌نویس** (${where}، ${strokes.length} خط)`);
  if (hl.quote_text && hl.quote_text.trim()) {
    lines.push(`  - متن کنار آن: «${hl.quote_text.trim().replace(/s+/g, ' ')}»`);
  }
  if (hl.note && hl.note.trim()) lines.push(`  - **یادداشت:** ${hl.note.trim()}`);
  if (strokes.length > 0) {
    const { strokes: cropped, aspect } = anchor
      ? { strokes, aspect: anchor.aspect }
      : cropInk(strokes, inkPageAspect(hl.rects));
    const svg = inkToSvg(cropped, { aspect, width: 480 })
      .replace('<svg ', `<svg width="${Math.max(80, Math.min(480, Math.round(320 / Math.max(aspect, 0.05))))}" style="max-width:100%;height:auto;background:#fffdf7;border:1px solid #e5dfd3;border-radius:6px" `);
    lines.push('', svg);
  } else {
    lines.push('  - _[یادداشت دست‌نویس خالی]_');
  }
  return lines;
}


// Full note text for a book that has no existing file (what the server writes on a first export).
export function buildObsidianNote(data) {
  const { frontmatter, body } = buildObsidianParts(data);
  return mergeObsidianNote('', frontmatter, body);
}
