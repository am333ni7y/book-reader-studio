export function sanitizeFilename(name) {
  return String(name || 'book')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'book';
}

export function buildObsidianMarkdown({ book, bookmarks = [], highlights = [], tocEntries = [] }) {
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

  const lines = [
    '---',
    `title: "${(book.title || '').replace(/"/g, '\\"')}"`,
    `author: "${(book.author || '').replace(/"/g, '\\"')}"`,
    `format: "${book.format || 'pdf'}"`,
    `total_${isEpub ? 'chapters' : 'pages'}: ${book.total_pages || 0}`,
    `current_${isEpub ? 'chapter' : 'page'}: ${book.current_page || 1}`,
    `progress: "${pct}%"`,
    `reading_minutes: ${readingMins}`,
    `last_read: "${book.last_opened_at || new Date().toISOString()}"`,
    'tags:',
    '  - reading-notes',
    '  - book-reader-studio',
    '---',
    '',
    `# ${book.title}`,
    '',
    `- **پیشرفت مطالعه:** ${unitLabel} ${book.current_page || 1} از ${book.total_pages || '?'} (${pct}%)`,
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

  return lines.join('\n');
}
