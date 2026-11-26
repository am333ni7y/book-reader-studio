import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  PROJECT_ROOT,
  loadDotEnv,
  resolveDataDir,
  resolveObsidianDir,
  getLanUrls,
} from './lib/paths.mjs';
import { openLibraryStore } from './lib/db-adapter.mjs';
import {
  parseEpubSummary,
  getEpubChapter,
  getEpubAsset,
  searchEpubBook,
} from './lib/epub-parser.mjs';

loadDotEnv();

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const PDFJS_DIR = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist'))
  ? path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist')
  : path.join(PUBLIC_DIR, 'vendor', 'pdfjs');
const VAZIR_DIR = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', 'vazirmatn'))
  ? path.join(PROJECT_ROOT, 'node_modules', 'vazirmatn')
  : path.join(PUBLIC_DIR, 'vendor', 'vazirmatn');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
};

export async function openDatabase(dataDir = resolveDataDir()) {
  const store = await openLibraryStore(dataDir);
  return { db: store, store, dataDir: store.dataDir, booksDir: store.booksDir };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function safeResolve(baseDir, reqSubPath) {
  const decoded = decodeURIComponent(reqSubPath.split('?')[0]);
  const cleanRel = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, cleanRel);
  const baseResolved = path.resolve(baseDir);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return resolved;
}

async function serveStaticFile(res, filePath, cacheControl = 'public, max-age=3600') {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Cache-Control': cacheControl,
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function cleanBookTitle(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'کتاب بدون عنوان';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim() || 'book';
}

function detectFormatFromMagic(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'pdf';
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    return 'epub';
  }
  return null;
}

export async function importBookFromFile({ store, db, booksDir, filePath, title = '' }) {
  const lib = store || db;
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    throw Object.assign(new Error('فایل در مسیر مشخص‌شده پیدا نشد.'), { statusCode: 404 });
  }
  if (!stat.isFile()) {
    throw Object.assign(new Error('مسیر انتخابی یک فایل نیست.'), { statusCode: 400 });
  }

  const fd = await fsp.open(resolved, 'r');
  const magic = Buffer.alloc(5);
  await fd.read(magic, 0, 5, 0);
  await fd.close();

  const format = detectFormatFromMagic(magic);
  if (!format) {
    throw Object.assign(new Error('فرمت فایل پشتیبانی نمی‌شود. فقط PDF و EPUB معتبر هستند.'), { statusCode: 400 });
  }

  const id = crypto.randomUUID();
  const ext = format === 'epub' ? '.epub' : '.pdf';
  const destPath = path.join(booksDir, `${id}${ext}`);
  await fsp.copyFile(resolved, destPath);

  const now = new Date().toISOString();
  const filename = path.basename(resolved);
  let finalTitle = String(title || '').trim() || cleanBookTitle(filename);
  let author = '';
  let totalPages = 0;
  let readingDir = 'rtl';
  let coverDataUrl = '';
  let zoomScale = 1.25;

  if (format === 'epub') {
    try {
      const summary = await parseEpubSummary(destPath);
      if (!String(title || '').trim() && summary.title) {
        finalTitle = summary.title;
      }
      author = summary.author || '';
      totalPages = summary.totalChapters || 0;
      readingDir = summary.readingDir || 'ltr';
      coverDataUrl = summary.coverDataUrl || '';
      zoomScale = 1.0;
    } catch (err) {
      await fsp.rm(destPath, { force: true }).catch(() => {});
      throw Object.assign(new Error(err.message || 'فایل EPUB معتبر نیست.'), { statusCode: 400 });
    }
  }

  return lib.insertBook({
    id,
    title: finalTitle,
    author,
    format,
    filename,
    file_path: destPath,
    file_size: stat.size,
    total_pages: totalPages,
    zoom_scale: zoomScale,
    reading_dir: readingDir,
    cover_data_url: coverDataUrl,
    created_at: now,
    last_opened_at: now,
  });
}

function buildObsidianMarkdown(data) {
  const { book, bookmarks, highlights, tocEntries } = data;
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
    `last_read: "${book.last_opened_at}"`,
    'tags:',
    '  - reading-notes',
    '  - book-reader-studio',
    '---',
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

async function handleApi(req, res, urlObj, ctx) {
  const { store, booksDir, obsidianDir } = ctx;
  const { pathname, searchParams } = urlObj;
  const method = req.method || 'GET';

  // GET /api/health
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, runtime: process.version, dbEngine: store.engine, formats: ['pdf', 'epub'] });
  }

  // GET /api/books
  if (method === 'GET' && pathname === '/api/books') {
    const books = store.listBooks();
    return sendJson(res, 200, { books });
  }

  // POST /api/books (Streaming raw binary PDF or EPUB upload)
  if (method === 'POST' && pathname === '/api/books') {
    const rawFilename = req.headers['x-book-filename']
      ? decodeURIComponent(String(req.headers['x-book-filename']))
      : 'book.pdf';
    const rawTitle = req.headers['x-book-title']
      ? decodeURIComponent(String(req.headers['x-book-title']))
      : '';
    const id = crypto.randomUUID();
    const tempPath = path.join(booksDir, `${id}.upload`);
    const writeStream = fs.createWriteStream(tempPath);

    let detectedFormat = null;
    let totalBytes = 0;

    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          if (!detectedFormat) {
            detectedFormat = detectFormatFromMagic(chunk);
            if (!detectedFormat) {
              reject(Object.assign(new Error('فایل ارسال‌شده PDF یا EPUB معتبر نیست.'), { statusCode: 400 }));
              req.destroy();
              return;
            }
          }
          totalBytes += chunk.length;
          if (!writeStream.write(chunk)) {
            req.pause();
            writeStream.once('drain', () => req.resume());
          }
        });
        req.on('end', () => {
          writeStream.end(resolve);
        });
        req.on('error', reject);
        writeStream.on('error', reject);
      });

      if (totalBytes === 0 || !detectedFormat) {
        await fsp.rm(tempPath, { force: true });
        return sendError(res, 400, 'فایل خالی یا نامعتبر است.');
      }

      const ext = detectedFormat === 'epub' ? '.epub' : '.pdf';
      const destPath = path.join(booksDir, `${id}${ext}`);
      await fsp.rename(tempPath, destPath);

      const now = new Date().toISOString();
      let title = rawTitle.trim() || cleanBookTitle(rawFilename);
      let author = '';
      let totalPages = 0;
      let readingDir = 'rtl';
      let coverDataUrl = '';
      let zoomScale = 1.25;

      if (detectedFormat === 'epub') {
        try {
          const summary = await parseEpubSummary(destPath);
          if (!rawTitle.trim() && summary.title) {
            title = summary.title;
          }
          author = summary.author || '';
          totalPages = summary.totalChapters || 0;
          readingDir = summary.readingDir || 'ltr';
          coverDataUrl = summary.coverDataUrl || '';
          zoomScale = 1.0;
        } catch (err) {
          await fsp.rm(destPath, { force: true }).catch(() => {});
          return sendError(res, 400, err.message || 'ساختار EPUB نامعتبر است.');
        }
      }

      const created = store.insertBook({
        id,
        title,
        author,
        format: detectedFormat,
        filename: rawFilename,
        file_path: destPath,
        file_size: totalBytes,
        total_pages: totalPages,
        zoom_scale: zoomScale,
        reading_dir: readingDir,
        cover_data_url: coverDataUrl,
        created_at: now,
        last_opened_at: now,
      });
      return sendJson(res, 201, { book: created });
    } catch (err) {
      writeStream.destroy();
      await fsp.rm(tempPath, { force: true }).catch(() => {});
      return sendError(res, err.statusCode || 500, err.message || 'خطا در ذخیره فایل کتاب');
    }
  }

  // POST /api/books/import-path
  if (method === 'POST' && pathname === '/api/books/import-path') {
    const body = await readJsonBody(req);
    const inputPath = String(body.filePath || '').trim();
    if (!inputPath) return sendError(res, 400, 'مسیر فایل وارد نشده است.');
    const created = await importBookFromFile({
      store,
      booksDir,
      filePath: inputPath,
      title: String(body.title || ''),
    });
    return sendJson(res, 201, { book: created });
  }

  // POST /api/books/seed
  if (method === 'POST' && pathname === '/api/books/seed') {
    const { buildSampleEpubBuffer } = await import('./scripts/generate-sample-book.mjs');
    const epubBuf = buildSampleEpubBuffer();
    const id = crypto.randomUUID();
    const destPath = path.join(booksDir, `${id}.epub`);
    await fsp.writeFile(destPath, epubBuf);
    const summary = await parseEpubSummary(destPath);
    const now = new Date().toISOString();
    const book = store.insertBook({
      id,
      title: summary.title || 'Sample EPUB',
      author: summary.author || 'Ketabkhan Studio',
      format: 'epub',
      filename: 'sample-bilingual.epub',
      file_path: destPath,
      file_size: epubBuf.length,
      total_pages: summary.totalChapters,
      zoom_scale: 1.0,
      reading_dir: summary.readingDir,
      cover_data_url: summary.coverDataUrl || '',
      created_at: now,
      last_opened_at: now,
    });
    return sendJson(res, 201, { book });
  }

  // Book-specific routes: /api/books/:id...
  const bookMatch = pathname.match(/^\/api\/books\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
  if (bookMatch) {
    const bookId = bookMatch[1];
    const sub = bookMatch[2] || '';

    // GET /api/books/:id/file (HTTP Range 206 streaming)
    if (method === 'GET' && sub === 'file') {
      const book = store.getBook(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');

      let stat;
      try {
        stat = await fsp.stat(book.file_path);
      } catch {
        return sendError(res, 404, 'فایل کتاب روی دیسک پیدا نشد.');
      }

      const total = stat.size;
      const range = req.headers.range;
      const contentType = book.format === 'epub' ? 'application/epub+zip' : 'application/pdf';
      const commonHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      };

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? Math.min(parseInt(parts[1], 10), total - 1) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, {
          ...commonHeaders,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(book.file_path, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, {
        ...commonHeaders,
        'Content-Length': total,
      });
      fs.createReadStream(book.file_path).pipe(res);
      return;
    }

    // GET /api/books/:id/epub-manifest
    if (method === 'GET' && sub === 'epub-manifest') {
      const book = store.getBook(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      if (book.format !== 'epub') return sendError(res, 400, 'این کتاب فرمت EPUB نیست.');
      const manifest = await parseEpubSummary(book.file_path);
      return sendJson(res, 200, manifest);
    }

    // GET /api/books/:id/epub-chapter/:num
    const chMatch = sub.match(/^epub-chapter\/(\d+)$/);
    if (method === 'GET' && chMatch) {
      const book = store.getBook(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      if (book.format !== 'epub') return sendError(res, 400, 'این کتاب فرمت EPUB نیست.');
      const chapter = await getEpubChapter(book.file_path, bookId, Number(chMatch[1]));
      return sendJson(res, 200, chapter);
    }

    // GET /api/books/:id/epub-asset/*
    if (method === 'GET' && sub.startsWith('epub-asset/')) {
      const book = store.getBook(bookId);
      if (!book || book.format !== 'epub') {
        res.writeHead(404);
        return res.end('Not found');
      }
      const assetRel = sub.slice('epub-asset/'.length);
      const asset = await getEpubAsset(book.file_path, bookId, assetRel);
      if (!asset) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': asset.mimeType,
        'Content-Length': asset.buffer.length,
        'Cache-Control': 'private, max-age=86400',
      });
      return res.end(asset.buffer);
    }

    // GET /api/books/:id/epub-search?q=...
    if (method === 'GET' && sub === 'epub-search') {
      const book = store.getBook(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      if (book.format !== 'epub') return sendError(res, 400, 'این کتاب فرمت EPUB نیست.');
      const q = searchParams.get('q') || '';
      const result = await searchEpubBook(book.file_path, q);
      return sendJson(res, 200, result);
    }

    // GET /api/books/:id
    if (method === 'GET' && sub === '') {
      const full = store.getBookFull(bookId);
      if (!full) return sendError(res, 404, 'کتاب پیدا نشد.');
      return sendJson(res, 200, full);
    }

    // PATCH /api/books/:id
    if (method === 'PATCH' && sub === '') {
      const body = await readJsonBody(req);
      const updated = store.updateBook(bookId, body);
      if (!updated) return sendError(res, 404, 'کتاب پیدا نشد.');
      return sendJson(res, 200, { book: updated });
    }

    // DELETE /api/books/:id
    if (method === 'DELETE' && sub === '') {
      const book = store.deleteBook(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      const resolvedFile = path.resolve(book.file_path);
      if (resolvedFile.startsWith(path.resolve(booksDir) + path.sep)) {
        await fsp.rm(resolvedFile, { force: true }).catch(() => {});
      }
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/books/:id/bookmarks
    if (method === 'POST' && sub === 'bookmarks') {
      const existing = store.getBook(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const page = Math.max(1, Number(body.page) || 1);
      const kind = body.kind === 'pin' ? 'pin' : 'ribbon';

      if (kind === 'ribbon' && body.toggle) {
        const toggled = store.toggleRibbonBookmark(bookId, page);
        if (toggled) return sendJson(res, 200, toggled);
      }

      const bookmark = store.insertBookmark({
        book_id: bookId,
        page,
        kind,
        label: String(body.label || ''),
        category: String(body.category || 'کلیدی'),
        color: String(body.color || 'amber'),
        note: String(body.note || ''),
      });
      return sendJson(res, 201, { bookmark });
    }

    // POST /api/books/:id/highlights
    if (method === 'POST' && sub === 'highlights') {
      const existing = store.getBook(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const rects = Array.isArray(body.rects) ? body.rects : [];
      if (rects.length === 0) return sendError(res, 400, 'مختصات هایلایت الزامی است.');

      const highlight = store.insertHighlight({
        book_id: bookId,
        page: Math.max(1, Number(body.page) || 1),
        kind: body.kind === 'area' ? 'area' : 'text',
        color: String(body.color || 'amber'),
        quote_text: String(body.quote_text || ''),
        note: String(body.note || ''),
        rects,
      });
      return sendJson(res, 201, { highlight });
    }

    // POST /api/books/:id/toc
    if (method === 'POST' && sub === 'toc') {
      const existing = store.getBook(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const page = Math.max(1, Number(body.page) || 1);
      if (!title) return sendError(res, 400, 'عنوان سرفصل الزامی است.');

      const tocEntry = store.insertTocEntry({
        book_id: bookId,
        title,
        page,
        level: Number(body.level) || 0,
        sort_order: Number(body.sort_order) || 0,
      });
      return sendJson(res, 201, { tocEntry });
    }

    // POST /api/books/:id/export-obsidian
    if (method === 'POST' && sub === 'export-obsidian') {
      const full = store.getBookFull(bookId);
      if (!full) return sendError(res, 404, 'کتاب پیدا نشد.');
      const markdown = buildObsidianMarkdown(full);
      await fsp.mkdir(obsidianDir, { recursive: true });
      const safeName = sanitizeFilename(full.book.title);
      const filename = `${safeName}.md`;
      const savedPath = path.join(obsidianDir, filename);
      await fsp.writeFile(savedPath, markdown, 'utf8');
      return sendJson(res, 200, { ok: true, savedPath, filename, markdown });
    }
  }

  // PATCH/DELETE /api/bookmarks/:bookmarkId
  const bmMatch = pathname.match(/^\/api\/bookmarks\/([a-zA-Z0-9-]+)$/);
  if (bmMatch) {
    const id = bmMatch[1];
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const bookmark = store.updateBookmark(id, body);
      return bookmark ? sendJson(res, 200, { bookmark }) : sendError(res, 404, 'نشان پیدا نشد.');
    }
    if (method === 'DELETE') {
      store.deleteBookmark(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // PATCH/DELETE /api/highlights/:highlightId
  const hlMatch = pathname.match(/^\/api\/highlights\/([a-zA-Z0-9-]+)$/);
  if (hlMatch) {
    const id = hlMatch[1];
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const highlight = store.updateHighlight(id, body);
      return highlight ? sendJson(res, 200, { highlight }) : sendError(res, 404, 'هایلایت پیدا نشد.');
    }
    if (method === 'DELETE') {
      store.deleteHighlight(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // DELETE /api/toc/:tocId
  const tocMatch = pathname.match(/^\/api\/toc\/([a-zA-Z0-9-]+)$/);
  if (tocMatch && method === 'DELETE') {
    store.deleteTocEntry(tocMatch[1]);
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'مسیر API پیدا نشد.');
}

export async function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || 3847),
  dataDir = resolveDataDir(),
  obsidianDir = resolveObsidianDir(),
  onReady = null,
} = {}) {
  const store = await openLibraryStore(dataDir);
  const ctx = { store, dataDir, booksDir: store.booksDir, obsidianDir };

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
      const { pathname } = urlObj;

      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, urlObj, ctx);
      }

      if (pathname.startsWith('/vendor/pdfjs/')) {
        const rel = pathname.slice('/vendor/pdfjs/'.length);
        const filePath = safeResolve(PDFJS_DIR, rel);
        if (filePath && await serveStaticFile(res, filePath, 'public, max-age=86400')) return;
        res.writeHead(404);
        return res.end('Not found');
      }

      if (pathname.startsWith('/vendor/vazirmatn/')) {
        const rel = pathname.slice('/vendor/vazirmatn/'.length);
        const filePath = safeResolve(VAZIR_DIR, rel);
        if (filePath && await serveStaticFile(res, filePath, 'public, max-age=86400')) return;
        res.writeHead(404);
        return res.end('Not found');
      }

      const publicRel = pathname === '/' ? 'index.html' : pathname;
      const publicPath = safeResolve(PUBLIC_DIR, publicRel);
      if (publicPath && await serveStaticFile(res, publicPath, 'no-cache')) return;

      // SPA fallback for /book/:id deep links
      if (!path.extname(pathname)) {
        await serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      console.error('[Server Error]', err);
      if (!res.headersSent) {
        sendError(res, err.statusCode || 500, err.message || 'Internal Server Error');
      }
    }
  });

  await new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      console.log(`Ketabkhan Studio running at http://${displayHost}:${actualPort}`);
      if (host === '0.0.0.0') {
        const lanUrls = getLanUrls(actualPort);
        if (lanUrls.length > 0) {
          console.log('LAN / Android access:');
          for (const u of lanUrls) console.log(`  -> ${u}`);
        }
      }
      const info = { server, store, host, port: actualPort, dataDir, obsidianDir };
      onReady?.(info);
      resolve(info);
    });
  });

  return { server, store, host, port: server.address()?.port || port, dataDir, obsidianDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startServer();
}
