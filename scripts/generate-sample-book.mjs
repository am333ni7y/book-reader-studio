import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { resolveDataDir } from '../lib/paths.mjs';
import { openDatabase } from '../server.mjs';
import { parseEpubSummary } from '../lib/epub-parser.mjs';

// Minimal CRC32 table for pure-Node ZIP/EPUB generation
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZipBuffer(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const method = file.store ? 0 : 8;
    const compressed = method === 0 ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    localChunks.push(lh, nameBuf, compressed);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);

    centralChunks.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

function buildSamplePdfBuffer() {
  const pagesData = [
    {
      title: 'Deep Reading & Systems Thinking',
      lines: [
        'Ketabkhan Studio - Sample Book',
        'Chapter 1: Foundations of Deep Reading',
        'Reading a book is an active dialogue with the author.',
        'Select any sentence in this paragraph to test text highlighting,',
        'choose from five curated colors, or attach a personal note.',
      ],
    },
    {
      title: 'Chapter 2: Information Architecture',
      lines: [
        'Chapter 2: Information Architecture & Note Taking',
        'Normalized coordinates ensure highlights stay pixel-accurate',
        'across zoom levels, single-page mode, and two-page spreads.',
      ],
    },
    {
      title: 'Chapter 3: Ergonomics & Visual Comfort',
      lines: [
        'Chapter 3: Ergonomics & Long-Session Comfort',
        'Switch between Paper, Sepia, Smart Dark, and Midnight themes.',
        'Press F to enter distraction-free Zen Mode at any time.',
      ],
    },
    {
      title: 'Chapter 4: Obsidian Knowledge Export',
      lines: [
        'Chapter 4: Exporting to Your Obsidian Second Brain',
        'Click Export Obsidian to compile all bookmarks and highlights',
        'into a structured Markdown note.',
      ],
    },
  ];

  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const outlinesId = addObj('');

  const pageIds = [];
  const outlineItemIds = [];

  for (let i = 0; i < pagesData.length; i++) {
    const p = pagesData[i];
    const streamLines = ['BT', '/F1 18 Tf', '60 760 Td', `(${p.lines[0].replace(/[()\\]/g, '\\$&')}) Tj`, '/F1 12 Tf', '0 -36 Td'];
    for (let j = 1; j < p.lines.length; j++) {
      streamLines.push(`(${p.lines[j].replace(/[()\\]/g, '\\$&')}) Tj`, '0 -22 Td');
    }
    streamLines.push('ET');
    const stream = streamLines.join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
    outlineItemIds.push(addObj(''));
  }

  for (let i = 0; i < pagesData.length; i++) {
    const prev = i > 0 ? `/Prev ${outlineItemIds[i - 1]} 0 R` : '';
    const next = i < pagesData.length - 1 ? `/Next ${outlineItemIds[i + 1]} 0 R` : '';
    const title = pagesData[i].title.replace(/[()\\]/g, '\\$&');
    objects[outlineItemIds[i] - 1] = `<< /Title (${title}) /Parent ${outlinesId} 0 R ${prev} ${next} /Dest [${pageIds[i]} 0 R /Fit] >>`;
  }

  objects[outlinesId - 1] = `<< /Type /Outlines /First ${outlineItemIds[0]} 0 R /Last ${outlineItemIds[outlineItemIds.length - 1]} 0 R /Count ${outlineItemIds.length} >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlinesId} 0 R >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

export function buildSampleEpubBuffer() {
  const files = [
    { name: 'mimetype', store: true, data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    },
    {
      name: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">ketabkhan-sample-epub</dc:identifier>
    <dc:title>هنر مطالعه عمیق — راهنمای EPUB</dc:title>
    <dc:creator>Ketabkhan Studio</dc:creator>
    <dc:language>fa</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
    },
    {
      name: 'OEBPS/style.css',
      data: `.lead { font-weight: 600; border-inline-start: 3px solid #9a5b13; padding-inline-start: 0.75rem; }`,
    },
    {
      name: 'OEBPS/nav.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="fa" dir="rtl">
<head><title>فهرست</title></head>
<body>
  <nav epub:type="toc">
    <ol>
      <li><a href="ch1.xhtml">فصل اول: چرا EPUB و مطالعه باز؟</a></li>
      <li><a href="ch2.xhtml">فصل دوم: هایلایت، بوکمارک و خروجی Obsidian</a></li>
    </ol>
  </nav>
</body>
</html>`,
    },
    {
      name: 'OEBPS/ch1.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="fa" dir="rtl">
<head><title>فصل اول</title><link rel="stylesheet" href="style.css"/></head>
<body>
  <h1>فصل اول: چرا EPUB و مطالعه باز؟</h1>
  <p class="lead">کتاب‌های EPUB متنی شناور (Reflowable) دارند و روی مک، ویندوز و اندروید با هر اندازه صفحه‌ای خوانا می‌مانند.</p>
  <p>می‌توانید هر جمله‌ای از این پاراگراف را انتخاب کنید و با ۵ رنگ مختلف هایلایت یا یادداشت‌گذاری کنید. همچنین لینک‌های داخلی مثل <a href="ch2.xhtml">رفتن به فصل دوم</a> بدون نیاز به بارگذاری مجدد کار می‌کنند.</p>
  <p dir="ltr">English paragraphs inside bilingual books also render cleanly with proper left-to-right flow and typography.</p>
</body>
</html>`,
    },
    {
      name: 'OEBPS/ch2.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="fa" dir="rtl">
<head><title>فصل دوم</title><link rel="stylesheet" href="style.css"/></head>
<body>
  <h1>فصل دوم: هایلایت، بوکمارک و خروجی Obsidian</h1>
  <p>تمام هایلایت‌های شما در دیتابیس محلی SQLite ذخیره می‌شوند و با یک کلیک روی دکمه خروجی Obsidian به فایل Markdown تبدیل می‌شوند.</p>
  <p>برای اجرای نسخه موبایل روی اندروید، کافی است سرور را با گزینه <code>ketabkhan --lan</code> اجرا کنید یا مستقیماً از Termux استفاده نمایید.</p>
</body>
</html>`,
    },
  ];
  return buildZipBuffer(files);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]).endsWith('generate-sample-book.mjs');
if (isCli) {
  const { db, booksDir } = await openDatabase(resolveDataDir());
  try {
    const existing = db.listBooks();
    if (existing.length === 0) {
      const now = new Date().toISOString();

      // 1. Seed Sample PDF
      const pdfBuf = buildSamplePdfBuffer();
      const pdfId = crypto.randomUUID();
      const pdfDest = path.join(booksDir, `${pdfId}.pdf`);
      fs.writeFileSync(pdfDest, pdfBuf);
      db.insertBook({
        id: pdfId,
        title: 'Deep Reading & Systems Thinking (Sample)',
        author: 'Ketabkhan Studio',
        format: 'pdf',
        filename: 'sample-book.pdf',
        file_path: pdfDest,
        file_size: pdfBuf.length,
        total_pages: 4,
        reading_dir: 'ltr',
        created_at: now,
        last_opened_at: now,
      });

      // 2. Seed Sample Bilingual EPUB
      const epubBuf = buildSampleEpubBuffer();
      const epubId = crypto.randomUUID();
      const epubDest = path.join(booksDir, `${epubId}.epub`);
      fs.writeFileSync(epubDest, epubBuf);
      const summary = await parseEpubSummary(epubDest);
      db.insertBook({
        id: epubId,
        title: summary.title,
        author: summary.author,
        format: 'epub',
        filename: 'sample-bilingual.epub',
        file_path: epubDest,
        file_size: epubBuf.length,
        total_pages: summary.totalChapters,
        zoom_scale: 1.0,
        reading_dir: summary.readingDir,
        created_at: now,
        last_opened_at: now,
      });

      console.log(`Seeded sample PDF (${pdfId}) and sample EPUB (${epubId}).`);
    } else {
      console.log('Library already contains books; skipping sample seed.');
    }
  } finally {
    db.close();
  }
}
