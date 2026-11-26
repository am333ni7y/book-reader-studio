import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
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
  obsidianFilename,
  mergeObsidianNote,
  buildObsidianParts,
} from './public/js/obsidian-markdown.js';

// Re-exported for tests/server.test.mjs, which imports it from here.
export { mergeObsidianNote };
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

const TOKEN_COOKIE = 'ketabkhan_token';

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
  const contentType = String(req.headers['content-type'] || '').trim().toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type باید application/json باشد.'), { statusCode: 415 });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('بدنه درخواست JSON معتبر نیست.'), { statusCode: 400 });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('بدنه درخواست باید یک شیء JSON باشد.'), { statusCode: 400 });
  }
  return parsed;
}

// DNS-rebinding guard: only loopback names or IP literals may appear in Host.
function isAllowedHostHeader(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return false;
  let url;
  try {
    url = new URL(`http://${hostHeader}`);
  } catch {
    return false;
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  return net.isIP(hostname) !== 0;
}

// CSRF guard: a present Origin must match the Host the request was sent to.
function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(String(origin)).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch {
    return false;
  }
}

function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || !candidate || !expected) return false;
  const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(candidate), digest(expected));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    out[name] = value;
  }
  return out;
}

function isAuthorizedApiRequest(req, urlObj, token) {
  const candidates = [
    req.headers['x-ketabkhan-token'],
    urlObj.searchParams.get('token'),
    parseCookies(req.headers.cookie)[TOKEN_COOKIE],
  ];
  return candidates.some((candidate) => tokenMatches(candidate, token));
}

// Parses a single HTTP Range header. Returns null when unsatisfiable or malformed.
function parseByteRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = parseInt(match[2], 10);
    if (suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
  }
  if (start >= total || start > end) return null;
  return { start, end };
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

  return finalizeImportedBook({
    store: lib,
    id,
    format,
    destPath,
    filename: path.basename(resolved),
    fileSize: stat.size,
    title,
  });
}

// Builds and inserts the book row for a file already stored at destPath.
// Shared by the POST /api/books upload route and importBookFromFile.
// An invalid EPUB removes destPath and throws a 400 error.
export async function finalizeImportedBook({ store, id, format, destPath, filename, fileSize, title = '' }) {
  const now = new Date().toISOString();
  const explicitTitle = String(title || '').trim();
  let finalTitle = explicitTitle || cleanBookTitle(filename);
  let author = '';
  let totalPages = 0;
  let readingDir = 'rtl';
  let coverDataUrl = '';
  let zoomScale = 1.25;

  if (format === 'epub') {
    try {
      const summary = await parseEpubSummary(destPath);
      if (!explicitTitle && summary.title) {
        finalTitle = summary.title;
      }
      author = summary.author || '';
      totalPages = summary.totalChapters || 0;
      readingDir = summary.readingDir || 'ltr';
      coverDataUrl = summary.coverDataUrl || '';
      zoomScale = 1.0;
    } catch (err) {
      await fsp.rm(destPath, { force: true }).catch(() => {});
      throw Object.assign(new Error(err.message || 'ساختار EPUB نامعتبر است.'), { statusCode: 400 });
    }
  }

  return store.insertBook({
    id,
    title: finalTitle,
    author,
    format,
    filename,
    file_path: destPath,
    file_size: fileSize,
    total_pages: totalPages,
    zoom_scale: zoomScale,
    reading_dir: readingDir,
    cover_data_url: coverDataUrl,
    created_at: now,
    last_opened_at: now,
  });
}

// ---- Library backup (annotations + reading state; book files are not included) ----
const BACKUP_FORMAT = 'ketabkhan-backup';
const BACKUP_VERSION = 1;
const BACKUP_BOOK_FIELDS = [
  'id', 'title', 'author', 'format', 'filename', 'file_size', 'total_pages', 'current_page',
  'scroll_ratio', 'zoom_mode', 'zoom_scale', 'view_mode', 'page_theme', 'reading_dir',
  'warmth', 'brightness', 'reading_seconds', 'last_opened_at',
];
const BACKUP_READING_FIELDS = [
  'current_page', 'scroll_ratio', 'zoom_mode', 'zoom_scale', 'view_mode', 'page_theme',
  'reading_dir', 'warmth', 'brightness', 'reading_seconds', 'last_opened_at',
];
const BACKUP_BOOKMARK_FIELDS = ['id', 'book_id', 'page', 'kind', 'label', 'category', 'color', 'note', 'created_at'];
const BACKUP_HIGHLIGHT_FIELDS = ['id', 'book_id', 'page', 'kind', 'color', 'quote_text', 'note', 'created_at', 'updated_at'];
const BACKUP_TOC_FIELDS = ['id', 'book_id', 'title', 'page', 'level', 'sort_order', 'created_at'];

function pickFields(source, fields) {
  return Object.fromEntries(fields.map((f) => [f, source[f] ?? null]));
}

function buildLibraryBackup(store) {
  const books = [];
  const bookmarks = [];
  const highlights = [];
  const tocEntries = [];
  for (const row of store.listBooks()) {
    const full = store.getBookFull(row.id);
    if (!full) continue;
    books.push(pickFields(full.book, BACKUP_BOOK_FIELDS));
    for (const bm of full.bookmarks) bookmarks.push(pickFields(bm, BACKUP_BOOKMARK_FIELDS));
    for (const hl of full.highlights) {
      highlights.push({ ...pickFields(hl, BACKUP_HIGHLIGHT_FIELDS), rects: hl.rects || [] });
    }
    for (const t of full.tocEntries) tocEntries.push(pickFields(t, BACKUP_TOC_FIELDS));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    books,
    bookmarks,
    highlights,
    toc_entries: tocEntries,
  };
}

// Matching: id, then (filename AND file_size), then (title AND format). Unmatched books are reported only.
function importLibraryBackup(store, backup) {
  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw Object.assign(new Error('فایل پشتیبان معتبر نیست (format/version).'), { statusCode: 400 });
  }
  const backupBooks = Array.isArray(backup.books) ? backup.books : [];
  const localBooks = store.listBooks();
  const localById = new Map(localBooks.map((b) => [b.id, b]));
  const idMap = new Map(); // backup book id -> local book id
  const unmatched = [];
  let matched = 0;

  for (const bb of backupBooks) {
    const local = localById.get(bb.id)
      || localBooks.find((b) => b.filename === bb.filename && Number(b.file_size) === Number(bb.file_size))
      || localBooks.find((b) => b.title === bb.title && b.format === bb.format);
    if (!local) {
      unmatched.push(bb.title || bb.filename || bb.id);
      continue;
    }
    matched += 1;
    idMap.set(bb.id, local.id);
    const patch = {};
    for (const key of BACKUP_READING_FIELDS) {
      if (bb[key] !== undefined && bb[key] !== null) patch[key] = bb[key];
    }
    store.updateBook(local.id, patch);
  }

  // Existing annotation ids on EVERY local book (ids are global primary keys), so re-importing adds nothing
  // and an id that already lives on another book is skipped instead of failing with a PK error.
  const existingIds = new Set();
  for (const localBook of localBooks) {
    const full = store.getBookFull(localBook.id);
    if (!full) continue;
    for (const list of [full.bookmarks, full.highlights, full.tocEntries]) {
      for (const item of list) existingIds.add(item.id);
    }
  }

  const inserted = { bookmarks: 0, highlights: 0, toc_entries: 0 };
  const listOf = (key) => (Array.isArray(backup[key]) ? backup[key] : []);

  const pageOf = (item) => Math.max(1, Number(item.page) || 1);

  // All-or-nothing on SQLite so a bad row cannot leave a half-imported library.
  const tx = store.rawDb;
  if (tx) tx.exec('BEGIN');
  try {
  for (const bm of listOf('bookmarks')) {
    const localId = idMap.get(bm.book_id);
    if (!localId || !bm.id || existingIds.has(bm.id)) continue;
    store.insertBookmark({ ...bm, book_id: localId, page: pageOf(bm) });
    existingIds.add(bm.id);
    inserted.bookmarks += 1;
  }
  for (const hl of listOf('highlights')) {
    const localId = idMap.get(hl.book_id);
    if (!localId || !hl.id || existingIds.has(hl.id)) continue;
    store.insertHighlight({ ...hl, book_id: localId, page: pageOf(hl), rects: Array.isArray(hl.rects) ? hl.rects : [] });
    existingIds.add(hl.id);
    inserted.highlights += 1;
  }
  for (const t of listOf('toc_entries')) {
    const localId = idMap.get(t.book_id);
    if (!localId || !t.id || existingIds.has(t.id)) continue;
    store.insertTocEntry({ ...t, book_id: localId, page: pageOf(t) });
    existingIds.add(t.id);
    inserted.toc_entries += 1;
  }
    if (tx) tx.exec('COMMIT');
  } catch (err) {
    if (tx) tx.exec('ROLLBACK');
    throw Object.assign(new Error(`بازیابی پشتیبان ناموفق بود: ${err.message}`), { statusCode: 400 });
  }

  return { ok: true, matched, unmatched, inserted };
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

      const created = await finalizeImportedBook({
        store,
        id,
        format: detectedFormat,
        destPath,
        filename: rawFilename,
        fileSize: totalBytes,
        title: rawTitle,
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

  // GET /api/library/export (annotations + reading state, no book files)
  if (method === 'GET' && pathname === '/api/library/export') {
    const backup = buildLibraryBackup(store);
    const body = JSON.stringify(backup);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Content-Disposition': `attachment; filename="ketabkhan-backup-${backup.exported_at.slice(0, 10)}.json"`,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  // POST /api/library/import (JSON body from export)
  if (method === 'POST' && pathname === '/api/library/import') {
    const backup = await readJsonBody(req, 50 * 1024 * 1024);
    return sendJson(res, 200, importLibraryBackup(store, backup));
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
        const parsed = parseByteRange(range, total);
        if (!parsed) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        const { start, end } = parsed;
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
      const { frontmatter, body } = buildObsidianParts(full);
      await fsp.mkdir(obsidianDir, { recursive: true });
      const filename = obsidianFilename(full.book);
      const savedPath = path.join(obsidianDir, filename);
      const existing = await fsp.readFile(savedPath, 'utf8').catch(() => '');
      const markdown = mergeObsidianNote(existing, frontmatter, body);
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
  token: tokenOption = '',
} = {}) {
  const store = await openLibraryStore(dataDir);
  const ctx = { store, dataDir, booksDir: store.booksDir, obsidianDir };

  const lanMode = !isLoopbackHost(host);
  const lanToken = lanMode
    ? String(tokenOption || process.env.KETABKHAN_TOKEN || '').trim() || crypto.randomBytes(16).toString('hex')
    : '';

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedHostHeader(req.headers.host)) {
        return sendError(res, 403, 'Host header not allowed');
      }

      const urlObj = new URL(req.url || '/', `http://${req.headers.host}`);
      const { pathname } = urlObj;

      if (pathname.startsWith('/api/')) {
        const isReadOnly = req.method === 'GET' || req.method === 'HEAD';
        if (!isReadOnly && !isSameOriginRequest(req)) {
          return sendError(res, 403, 'Cross-origin request blocked');
        }
        if (lanMode && !isAuthorizedApiRequest(req, urlObj, lanToken)) {
          return sendError(res, 401, 'Token required');
        }
        return await handleApi(req, res, urlObj, ctx);
      }

      if (lanMode && (req.method === 'GET' || req.method === 'HEAD') && urlObj.searchParams.has('token')) {
        if (tokenMatches(urlObj.searchParams.get('token'), lanToken)) {
          urlObj.searchParams.delete('token');
          const query = urlObj.searchParams.toString();
          const location = `${pathname}${query ? `?${query}` : ''}${urlObj.hash}`;
          res.writeHead(302, {
            Location: location,
            'Set-Cookie': `${TOKEN_COOKIE}=${encodeURIComponent(lanToken)}; HttpOnly; SameSite=Strict; Path=/`,
            'Cache-Control': 'no-store',
          });
          return res.end();
        }
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
      const displayHost = lanMode && host === '0.0.0.0' ? '127.0.0.1' : host;
      console.log(`Ketabkhan Studio running at http://${displayHost}:${actualPort}`);
      if (lanMode) {
        const lanUrls = getLanUrls(actualPort, lanToken);
        if (lanUrls.length > 0) {
          console.log('LAN / Android access (token required for /api):');
          for (const u of lanUrls) console.log(`  -> ${u}`);
        } else {
          console.log(`Access token: ${lanToken}`);
        }
      }
      const info = { server, store, host, port: actualPort, dataDir, obsidianDir, token: lanToken, lan: lanMode };
      onReady?.(info);
      resolve(info);
    });
  });

  return {
    server,
    store,
    host,
    port: server.address()?.port || port,
    dataDir,
    obsidianDir,
    token: lanToken,
    lan: lanMode,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await startServer();
}
