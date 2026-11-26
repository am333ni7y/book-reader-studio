// Pure Browser IndexedDB Backend for Android APK & Standalone Offline WebView
import { buildObsidianMarkdown, sanitizeFilename } from './obsidian-markdown.js';
import {
  parseClientEpubSummary,
  getClientEpubManifest,
  getClientEpubChapter,
  searchClientEpub,
  releaseClientEpubAssets,
  createSampleEpubFile,
} from './epub-client.js';

const DB_NAME = 'ketabkhan_studio_db';
const DB_VERSION = 1;

let dbPromise = null;

function openIdb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        db.createObjectStore('books', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('book_files')) {
        db.createObjectStore('book_files', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('bookmarks')) {
        const s = db.createObjectStore('bookmarks', { keyPath: 'id' });
        s.createIndex('by_book', 'book_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('highlights')) {
        const s = db.createObjectStore('highlights', { keyPath: 'id' });
        s.createIndex('by_book', 'book_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('toc_entries')) {
        const s = db.createObjectStore('toc_entries', { keyPath: 'id' });
        s.createIndex('by_book', 'book_id', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllFromStore(storeName) {
  const db = await openIdb();
  const tx = db.transaction(storeName, 'readonly');
  return idbReq(tx.objectStore(storeName).getAll());
}

async function getByBookIndex(storeName, bookId) {
  const db = await openIdb();
  const tx = db.transaction(storeName, 'readonly');
  const idx = tx.objectStore(storeName).index('by_book');
  return idbReq(idx.getAll(bookId));
}

async function getRecord(storeName, id) {
  const db = await openIdb();
  const tx = db.transaction(storeName, 'readonly');
  return idbReq(tx.objectStore(storeName).get(id));
}

async function putRecord(storeName, record) {
  const db = await openIdb();
  const tx = db.transaction(storeName, 'readwrite');
  await idbReq(tx.objectStore(storeName).put(record));
  return record;
}

async function deleteRecord(storeName, id) {
  const db = await openIdb();
  const tx = db.transaction(storeName, 'readwrite');
  await idbReq(tx.objectStore(storeName).delete(id));
}

function cleanBookTitle(filename) {
  return String(filename || 'book')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'کتاب بدون عنوان';
}

function detectMagic(bytes) {
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'pdf';
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return 'epub';
  }
  return null;
}

export const clientBackend = {
  async listBooks() {
    const [books, highlights, bookmarks] = await Promise.all([
      getAllFromStore('books'),
      getAllFromStore('highlights'),
      getAllFromStore('bookmarks'),
    ]);
    const hlMap = new Map();
    const bmMap = new Map();
    for (const h of highlights) hlMap.set(h.book_id, (hlMap.get(h.book_id) || 0) + 1);
    for (const b of bookmarks) bmMap.set(b.book_id, (bmMap.get(b.book_id) || 0) + 1);

    const enriched = books
      .sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)))
      .map((b) => ({
        ...b,
        highlight_count: hlMap.get(b.id) || 0,
        bookmark_count: bmMap.get(b.id) || 0,
      }));
    return { books: enriched };
  },

  async getBook(id) {
    const book = await getRecord('books', id);
    if (!book) throw new Error('کتاب پیدا نشد.');
    const [bookmarks, highlights, tocEntries] = await Promise.all([
      getByBookIndex('bookmarks', id),
      getByBookIndex('highlights', id),
      getByBookIndex('toc_entries', id),
    ]);
    bookmarks.sort((a, b) => a.page - b.page);
    highlights.sort((a, b) => a.page - b.page);
    tocEntries.sort((a, b) => a.page - b.page);
    return { book, bookmarks, highlights, tocEntries };
  },

  async getBookPdfSource(id) {
    const rec = await getRecord('book_files', id);
    if (!rec?.blob) throw new Error('فایل کتاب در حافظه دستگاه پیدا نشد.');
    return { data: new Uint8Array(await rec.blob.arrayBuffer()) };
  },

  async getEpubManifest(id) {
    const rec = await getRecord('book_files', id);
    if (!rec?.blob) throw new Error('فایل EPUB پیدا نشد.');
    return getClientEpubManifest(id, rec.blob);
  },

  async getEpubChapter(id, chapterNum) {
    const rec = await getRecord('book_files', id);
    if (!rec?.blob) throw new Error('فایل EPUB پیدا نشد.');
    return getClientEpubChapter(id, rec.blob, chapterNum);
  },

  async searchEpub(id, q) {
    const rec = await getRecord('book_files', id);
    if (!rec?.blob) throw new Error('فایل EPUB پیدا نشد.');
    return searchClientEpub(id, rec.blob, q);
  },

  releaseBookResources(id) {
    if (id) releaseClientEpubAssets(id);
  },

  async updateBook(id, patch) {
    const book = await getRecord('books', id);
    if (!book) throw new Error('کتاب پیدا نشد.');
    const updated = { ...book, ...patch };
    await putRecord('books', updated);
    return { book: updated };
  },

  async deleteBook(id) {
    releaseClientEpubAssets(id);
    const [bookmarks, highlights, toc] = await Promise.all([
      getByBookIndex('bookmarks', id),
      getByBookIndex('highlights', id),
      getByBookIndex('toc_entries', id),
    ]);
    const db = await openIdb();
    const tx = db.transaction(['books', 'book_files', 'bookmarks', 'highlights', 'toc_entries'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('book_files').delete(id);
    for (const b of bookmarks) tx.objectStore('bookmarks').delete(b.id);
    for (const h of highlights) tx.objectStore('highlights').delete(h.id);
    for (const t of toc) tx.objectStore('toc_entries').delete(t.id);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return { ok: true };
  },

  async uploadBookFile(file, onProgress) {
    onProgress?.(20);
    const headBytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const format = detectMagic(headBytes);
    if (!format) {
      throw new Error('فایل انتخاب‌شده PDF یا EPUB معتبر نیست.');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    let title = cleanBookTitle(file.name);
    let author = '';
    let totalPages = 0;
    let readingDir = 'rtl';
    let coverDataUrl = '';
    let zoomScale = 1.25;

    if (format === 'epub') {
      const summary = await parseClientEpubSummary(file);
      if (summary.title) title = summary.title;
      author = summary.author || '';
      totalPages = summary.totalChapters || 0;
      readingDir = summary.readingDir || 'ltr';
      coverDataUrl = summary.coverDataUrl || '';
      zoomScale = 1.0;
    }

    onProgress?.(70);
    const book = {
      id,
      title,
      author,
      format,
      filename: file.name,
      file_path: `indexeddb://${id}`,
      file_size: file.size,
      total_pages: totalPages,
      current_page: 1,
      scroll_ratio: 0,
      zoom_mode: 'fit-width',
      zoom_scale: zoomScale,
      view_mode: 'scroll',
      page_theme: 'paper',
      reading_dir: readingDir,
      warmth: 0,
      brightness: 100,
      reading_seconds: 0,
      cover_data_url: coverDataUrl,
      created_at: now,
      last_opened_at: now,
    };

    await putRecord('book_files', { id, blob: file });
    await putRecord('books', book);
    onProgress?.(100);
    return { book };
  },

  async seedSampleBook() {
    const file = createSampleEpubFile();
    return this.uploadBookFile(file);
  },

  async toggleRibbonBookmark(bookId, page) {
    const list = await getByBookIndex('bookmarks', bookId);
    const dup = list.find((b) => b.page === page && b.kind === 'ribbon');
    if (dup) {
      await deleteRecord('bookmarks', dup.id);
      return { removed: true, id: dup.id };
    }
    const bookmark = {
      id: crypto.randomUUID(),
      book_id: bookId,
      page,
      kind: 'ribbon',
      label: '',
      category: 'کلیدی',
      color: 'amber',
      note: '',
      created_at: new Date().toISOString(),
    };
    await putRecord('bookmarks', bookmark);
    return { bookmark };
  },

  async createPinBookmark(bookId, payload) {
    const bookmark = {
      id: crypto.randomUUID(),
      book_id: bookId,
      page: Math.max(1, Number(payload.page) || 1),
      kind: 'pin',
      label: String(payload.label || ''),
      category: String(payload.category || 'کلیدی'),
      color: String(payload.color || 'amber'),
      note: String(payload.note || ''),
      created_at: new Date().toISOString(),
    };
    await putRecord('bookmarks', bookmark);
    return { bookmark };
  },

  async deleteBookmark(bookmarkId) {
    await deleteRecord('bookmarks', bookmarkId);
    return { ok: true };
  },

  async createHighlight(bookId, payload) {
    const now = new Date().toISOString();
    const highlight = {
      id: crypto.randomUUID(),
      book_id: bookId,
      page: Math.max(1, Number(payload.page) || 1),
      kind: payload.kind === 'area' ? 'area' : 'text',
      color: String(payload.color || 'amber'),
      quote_text: String(payload.quote_text || ''),
      note: String(payload.note || ''),
      rects: Array.isArray(payload.rects) ? payload.rects : [],
      created_at: now,
      updated_at: now,
    };
    await putRecord('highlights', highlight);
    return { highlight };
  },

  async updateHighlight(highlightId, patch) {
    const hl = await getRecord('highlights', highlightId);
    if (!hl) throw new Error('هایلایت پیدا نشد.');
    const updated = { ...hl, ...patch, updated_at: new Date().toISOString() };
    await putRecord('highlights', updated);
    return { highlight: updated };
  },

  async deleteHighlight(highlightId) {
    await deleteRecord('highlights', highlightId);
    return { ok: true };
  },

  async createTocEntry(bookId, payload) {
    const tocEntry = {
      id: crypto.randomUUID(),
      book_id: bookId,
      title: String(payload.title || '').trim(),
      page: Math.max(1, Number(payload.page) || 1),
      level: Number(payload.level) || 0,
      sort_order: Number(payload.sort_order) || 0,
      created_at: new Date().toISOString(),
    };
    await putRecord('toc_entries', tocEntry);
    return { tocEntry };
  },

  async deleteTocEntry(tocId) {
    await deleteRecord('toc_entries', tocId);
    return { ok: true };
  },

  async exportObsidian(bookId) {
    const full = await this.getBook(bookId);
    const markdown = buildObsidianMarkdown(full);
    const filename = `${sanitizeFilename(full.book.title)}.md`;
    const mdFile = new File([markdown], filename, { type: 'text/markdown;charset=utf-8' });

    if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [mdFile] })) {
      try {
        await navigator.share({ title: full.book.title, files: [mdFile] });
        return { ok: true, filename, savedPath: 'اشتراک‌گذاری مستقیم با Obsidian / فایل‌ها', markdown };
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw new Error('اشتراک‌گذاری لغو شد.');
        }
      }
    }

    const blobUrl = URL.createObjectURL(mdFile);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
    return { ok: true, filename, savedPath: `دانلود فایل ${filename}`, markdown };
  },
};
