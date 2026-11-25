import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  PROJECT_ROOT,
  loadDotEnv,
  resolveDataDir,
  resolveObsidianDir,
  getLanUrls,
} from './lib/paths.mjs';
import {
  parseEpubSummary,
  getEpubChapter,
  getEpubAsset,
  searchEpubBook,
} from './lib/epub-parser.mjs';

loadDotEnv();

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const PDFJS_DIR = path.join(PROJECT_ROOT, 'node_modules', 'pdfjs-dist');
const VAZIR_DIR = path.join(PROJECT_ROOT, 'node_modules', 'vazirmatn');

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

export function openDatabase(dataDir = resolveDataDir()) {
  const booksDir = path.join(dataDir, 'books');
  fs.mkdirSync(booksDir, { recursive: true });

  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT DEFAULT '',
      format TEXT DEFAULT 'pdf',
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      total_pages INTEGER DEFAULT 0,
      current_page INTEGER DEFAULT 1,
      scroll_ratio REAL DEFAULT 0,
      zoom_mode TEXT DEFAULT 'fit-width',
      zoom_scale REAL DEFAULT 1.25,
      view_mode TEXT DEFAULT 'scroll',
      page_theme TEXT DEFAULT 'paper',
      reading_dir TEXT DEFAULT 'rtl',
      warmth INTEGER DEFAULT 0,
      brightness INTEGER DEFAULT 100,
      reading_seconds INTEGER DEFAULT 0,
      cover_data_url TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ribbon',
      label TEXT DEFAULT '',
      category TEXT DEFAULT 'کلیدی',
      color TEXT DEFAULT 'amber',
      note TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      page INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      color TEXT NOT NULL DEFAULT 'amber',
      quote_text TEXT DEFAULT '',
      note TEXT DEFAULT '',
      rects_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS toc_entries (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      page INTEGER NOT NULL,
      level INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_book ON bookmarks(book_id, page);
    CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights(book_id, page);
    CREATE INDEX IF NOT EXISTS idx_toc_book ON toc_entries(book_id, page, sort_order);
  `);

  const cols = db.prepare('PRAGMA table_info(books)').all();
  if (!cols.some((c) => c.name === 'format')) {
    db.exec("ALTER TABLE books ADD COLUMN format TEXT DEFAULT 'pdf';");
  }

  return { db, dataDir, booksDir };
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

export async function importBookFromFile({ db, booksDir, filePath, title = '' }) {
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

  db.prepare(`
    INSERT INTO books (id, title, author, format, filename, file_path, file_size, total_pages, zoom_scale, reading_dir, cover_data_url, created_at, last_opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, finalTitle, author, format, filename, destPath, stat.size, totalPages, zoomScale, readingDir, coverDataUrl, now, now);

  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

function getBookFull(db, bookId) {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!book) return null;
  const bookmarks = db.prepare('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page ASC, created_at ASC').all(bookId);
  const highlights = db.prepare('SELECT * FROM highlights WHERE book_id = ? ORDER BY page ASC, created_at ASC').all(bookId)
    .map((h) => ({ ...h, rects: JSON.parse(h.rects_json) }));
  const tocEntries = db.prepare('SELECT * FROM toc_entries WHERE book_id = ? ORDER BY page ASC, sort_order ASC, created_at ASC').all(bookId);
  return { book, bookmarks, highlights, tocEntries };
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
  const { db, booksDir, obsidianDir } = ctx;
  const { pathname, searchParams } = urlObj;
  const method = req.method || 'GET';

  // GET /api/health
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, runtime: process.version, formats: ['pdf', 'epub'] });
  }

  // GET /api/books
  if (method === 'GET' && pathname === '/api/books') {
    const books = db.prepare(`
      SELECT b.*,
        (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count,
        (SELECT COUNT(*) FROM bookmarks bm WHERE bm.book_id = b.id) AS bookmark_count
      FROM books b
      ORDER BY b.last_opened_at DESC, b.created_at DESC
    `).all();
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

      db.prepare(`
        INSERT INTO books (id, title, author, format, filename, file_path, file_size, total_pages, zoom_scale, reading_dir, cover_data_url, created_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, title, author, detectedFormat, rawFilename, destPath, totalBytes, totalPages, zoomScale, readingDir, coverDataUrl, now, now);

      const created = db.prepare('SELECT * FROM books WHERE id = ?').get(id);
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
      db,
      booksDir,
      filePath: inputPath,
      title: String(body.title || ''),
    });
    return sendJson(res, 201, { book: created });
  }

  // Book-specific routes: /api/books/:id...
  const bookMatch = pathname.match(/^\/api\/books\/([a-zA-Z0-9-]+)(?:\/(.*))?$/);
  if (bookMatch) {
    const bookId = bookMatch[1];
    const sub = bookMatch[2] || '';

    // GET /api/books/:id/file (HTTP Range 206 streaming)
    if (method === 'GET' && sub === 'file') {
      const book = db.prepare('SELECT file_path, filename, format FROM books WHERE id = ?').get(bookId);
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
      const book = db.prepare('SELECT file_path, format FROM books WHERE id = ?').get(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      if (book.format !== 'epub') return sendError(res, 400, 'این کتاب فرمت EPUB نیست.');
      const manifest = await parseEpubSummary(book.file_path);
      return sendJson(res, 200, manifest);
    }

    // GET /api/books/:id/epub-chapter/:num
    const chMatch = sub.match(/^epub-chapter\/(\d+)$/);
    if (method === 'GET' && chMatch) {
      const book = db.prepare('SELECT file_path, format FROM books WHERE id = ?').get(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      if (book.format !== 'epub') return sendError(res, 400, 'این کتاب فرمت EPUB نیست.');
      const chapter = await getEpubChapter(book.file_path, bookId, Number(chMatch[1]));
      return sendJson(res, 200, chapter);
    }

    // GET /api/books/:id/epub-asset/*
    if (method === 'GET' && sub.startsWith('epub-asset/')) {
      const book = db.prepare('SELECT file_path, format FROM books WHERE id = ?').get(bookId);
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
      const book = db.prepare('SELECT file_path, format FROM books WHERE id = ?').get(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      if (book.format !== 'epub') return sendError(res, 400, 'این کتاب فرمت EPUB نیست.');
      const q = searchParams.get('q') || '';
      const result = await searchEpubBook(book.file_path, q);
      return sendJson(res, 200, result);
    }

    // GET /api/books/:id
    if (method === 'GET' && sub === '') {
      const full = getBookFull(db, bookId);
      if (!full) return sendError(res, 404, 'کتاب پیدا نشد.');
      return sendJson(res, 200, full);
    }

    // PATCH /api/books/:id
    if (method === 'PATCH' && sub === '') {
      const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const allowed = [
        'title', 'author', 'total_pages', 'current_page', 'scroll_ratio',
        'zoom_mode', 'zoom_scale', 'view_mode', 'page_theme', 'reading_dir',
        'warmth', 'brightness', 'reading_seconds', 'cover_data_url', 'last_opened_at',
      ];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (Object.hasOwn(body, key)) {
          sets.push(`${key} = ?`);
          values.push(body[key]);
        }
      }
      if (sets.length > 0) {
        values.push(bookId);
        db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      const updated = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
      return sendJson(res, 200, { book: updated });
    }

    // DELETE /api/books/:id
    if (method === 'DELETE' && sub === '') {
      const book = db.prepare('SELECT file_path FROM books WHERE id = ?').get(bookId);
      if (!book) return sendError(res, 404, 'کتاب پیدا نشد.');
      db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
      const resolvedFile = path.resolve(book.file_path);
      if (resolvedFile.startsWith(path.resolve(booksDir) + path.sep)) {
        await fsp.rm(resolvedFile, { force: true }).catch(() => {});
      }
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/books/:id/bookmarks
    if (method === 'POST' && sub === 'bookmarks') {
      const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const page = Math.max(1, Number(body.page) || 1);
      const kind = body.kind === 'pin' ? 'pin' : 'ribbon';

      if (kind === 'ribbon' && body.toggle) {
        const dup = db.prepare("SELECT id FROM bookmarks WHERE book_id = ? AND page = ? AND kind = 'ribbon'").get(bookId, page);
        if (dup) {
          db.prepare('DELETE FROM bookmarks WHERE id = ?').run(dup.id);
          return sendJson(res, 200, { removed: true, id: dup.id });
        }
      }

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO bookmarks (id, book_id, page, kind, label, category, color, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        bookId,
        page,
        kind,
        String(body.label || ''),
        String(body.category || 'کلیدی'),
        String(body.color || 'amber'),
        String(body.note || ''),
        now
      );
      const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
      return sendJson(res, 201, { bookmark });
    }

    // POST /api/books/:id/highlights
    if (method === 'POST' && sub === 'highlights') {
      const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const rects = Array.isArray(body.rects) ? body.rects : [];
      if (rects.length === 0) return sendError(res, 400, 'مختصات هایلایت الزامی است.');

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO highlights (id, book_id, page, kind, color, quote_text, note, rects_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        bookId,
        Math.max(1, Number(body.page) || 1),
        body.kind === 'area' ? 'area' : 'text',
        String(body.color || 'amber'),
        String(body.quote_text || ''),
        String(body.note || ''),
        JSON.stringify(rects),
        now,
        now
      );
      const row = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
      return sendJson(res, 201, { highlight: { ...row, rects: JSON.parse(row.rects_json) } });
    }

    // POST /api/books/:id/toc
    if (method === 'POST' && sub === 'toc') {
      const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(bookId);
      if (!existing) return sendError(res, 404, 'کتاب پیدا نشد.');
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const page = Math.max(1, Number(body.page) || 1);
      if (!title) return sendError(res, 400, 'عنوان سرفصل الزامی است.');

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO toc_entries (id, book_id, title, page, level, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, bookId, title, page, Number(body.level) || 0, Number(body.sort_order) || 0, now);

      const entry = db.prepare('SELECT * FROM toc_entries WHERE id = ?').get(id);
      return sendJson(res, 201, { tocEntry: entry });
    }

    // POST /api/books/:id/export-obsidian
    if (method === 'POST' && sub === 'export-obsidian') {
      const full = getBookFull(db, bookId);
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
      const sets = [];
      const vals = [];
      for (const key of ['label', 'category', 'color', 'note', 'page']) {
        if (Object.hasOwn(body, key)) {
          sets.push(`${key} = ?`);
          vals.push(body[key]);
        }
      }
      if (sets.length > 0) {
        vals.push(id);
        db.prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
      return bookmark ? sendJson(res, 200, { bookmark }) : sendError(res, 404, 'نشان پیدا نشد.');
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // PATCH/DELETE /api/highlights/:highlightId
  const hlMatch = pathname.match(/^\/api\/highlights\/([a-zA-Z0-9-]+)$/);
  if (hlMatch) {
    const id = hlMatch[1];
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const sets = ['updated_at = ?'];
      const vals = [new Date().toISOString()];
      for (const key of ['color', 'note', 'quote_text']) {
        if (Object.hasOwn(body, key)) {
          sets.push(`${key} = ?`);
          vals.push(body[key]);
        }
      }
      vals.push(id);
      db.prepare(`UPDATE highlights SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const row = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
      return row ? sendJson(res, 200, { highlight: { ...row, rects: JSON.parse(row.rects_json) } }) : sendError(res, 404, 'هایلایت پیدا نشد.');
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM highlights WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // DELETE /api/toc/:tocId
  const tocMatch = pathname.match(/^\/api\/toc\/([a-zA-Z0-9-]+)$/);
  if (tocMatch && method === 'DELETE') {
    db.prepare('DELETE FROM toc_entries WHERE id = ?').run(tocMatch[1]);
    return sendJson(res, 200, { ok: true });
  }

  return sendError(res, 404, 'مسیر API پیدا نشد.');
}

export function startServer({
  host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || 3847),
  dataDir = resolveDataDir(),
  obsidianDir = resolveObsidianDir(),
  onReady = null,
} = {}) {
  const { db, booksDir } = openDatabase(dataDir);
  const ctx = { db, dataDir, booksDir, obsidianDir };

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

  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    console.log(`Ketabkhan Studio running at http://${displayHost}:${port}`);
    if (host === '0.0.0.0') {
      const lanUrls = getLanUrls(port);
      if (lanUrls.length > 0) {
        console.log('LAN / Android access:');
        for (const u of lanUrls) console.log(`  -> ${u}`);
      }
    }
    onReady?.({ server, host, port, dataDir, obsidianDir });
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer();
}
