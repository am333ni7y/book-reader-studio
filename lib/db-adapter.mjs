import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeHighlightKind, sanitizeInkRects } from '../public/js/ink-core.js';

let sqliteMod = null;
try {
  sqliteMod = await import('node:sqlite');
} catch {
  sqliteMod = null;
}

const SQLITE_SCHEMA = `
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
`;

const BOOK_NUMERIC_FIELDS = ['total_pages', 'current_page', 'scroll_ratio', 'zoom_scale', 'warmth', 'brightness', 'reading_seconds'];
const BOOK_STRING_FIELDS = ['title', 'author', 'zoom_mode', 'view_mode', 'page_theme', 'reading_dir', 'cover_data_url', 'last_opened_at'];
const BOOKMARK_NUMERIC_FIELDS = ['page'];
const BOOKMARK_STRING_FIELDS = ['label', 'category', 'color', 'note'];
const HIGHLIGHT_STRING_FIELDS = ['color', 'note', 'quote_text'];

// Ink strokes are the only rects that may change after creation (pen append / stroke eraser).
function inkRectsPatch(patch, current) {
  if (!current || current.kind !== 'ink' || !Object.hasOwn(patch, 'rects')) return null;
  return sanitizeInkRects(patch.rects);
}

// Keeps only whitelisted keys. Numeric keys must convert to a finite number (objects and arrays are dropped);
// string keys are coerced with String() (null or undefined becomes an empty string).
function sanitizePatch(patch, numericKeys, stringKeys) {
  const out = {};
  for (const key of numericKeys) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    // null, '', objects and arrays would silently become 0 or fail in SQLite: skip them.
    if (value === null || typeof value === 'object' || (typeof value === 'string' && value.trim() === '')) continue;
    const num = Number(value);
    if (Number.isFinite(num)) out[key] = num;
  }
  for (const key of stringKeys) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    out[key] = value === null || value === undefined ? '' : String(value);
  }
  return out;
}

function createSqliteStore(dataDir, booksDir) {
  const { DatabaseSync } = sqliteMod;
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
  db.exec(SQLITE_SCHEMA);

  const cols = db.prepare('PRAGMA table_info(books)').all();
  if (!cols.some((c) => c.name === 'format')) {
    db.exec("ALTER TABLE books ADD COLUMN format TEXT DEFAULT 'pdf';");
  }

  return {
    engine: 'sqlite',
    dataDir,
    booksDir,
    rawDb: db,

    listBooks() {
      return db.prepare(`
        SELECT b.*,
          (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count,
          (SELECT COUNT(*) FROM bookmarks bm WHERE bm.book_id = b.id) AS bookmark_count
        FROM books b
        ORDER BY b.last_opened_at DESC, b.created_at DESC
      `).all();
    },

    getBook(id) {
      return db.prepare('SELECT * FROM books WHERE id = ?').get(id) || null;
    },

    insertBook(row) {
      db.prepare(`
        INSERT INTO books (id, title, author, format, filename, file_path, file_size, total_pages, zoom_scale, reading_dir, cover_data_url, created_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.title,
        row.author || '',
        row.format || 'pdf',
        row.filename,
        row.file_path,
        row.file_size,
        row.total_pages || 0,
        row.zoom_scale ?? 1.25,
        row.reading_dir || 'rtl',
        row.cover_data_url || '',
        row.created_at,
        row.last_opened_at
      );
      return this.getBook(row.id);
    },

    updateBook(id, patch) {
      const existing = db.prepare('SELECT id FROM books WHERE id = ?').get(id);
      if (!existing) return null;
      const allowed = [
        'title', 'author', 'total_pages', 'current_page', 'scroll_ratio',
        'zoom_mode', 'zoom_scale', 'view_mode', 'page_theme', 'reading_dir',
        'warmth', 'brightness', 'reading_seconds', 'cover_data_url', 'last_opened_at',
      ];
      const clean = sanitizePatch(patch, BOOK_NUMERIC_FIELDS, BOOK_STRING_FIELDS);
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (Object.hasOwn(clean, key)) {
          sets.push(`${key} = ?`);
          values.push(clean[key]);
        }
      }
      if (sets.length > 0) {
        values.push(id);
        db.prepare(`UPDATE books SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      return this.getBook(id);
    },

    deleteBook(id) {
      const book = this.getBook(id);
      if (!book) return null;
      db.prepare('DELETE FROM books WHERE id = ?').run(id);
      return book;
    },

    getBookFull(bookId) {
      const book = this.getBook(bookId);
      if (!book) return null;
      const bookmarks = db.prepare('SELECT * FROM bookmarks WHERE book_id = ? ORDER BY page ASC, created_at ASC').all(bookId);
      const highlights = db.prepare('SELECT * FROM highlights WHERE book_id = ? ORDER BY page ASC, created_at ASC').all(bookId)
        .map((h) => ({ ...h, rects: JSON.parse(h.rects_json) }));
      const tocEntries = db.prepare('SELECT * FROM toc_entries WHERE book_id = ? ORDER BY page ASC, sort_order ASC, created_at ASC').all(bookId);
      return { book, bookmarks, highlights, tocEntries };
    },

    toggleRibbonBookmark(bookId, page) {
      const dup = db.prepare("SELECT id FROM bookmarks WHERE book_id = ? AND page = ? AND kind = 'ribbon'").get(bookId, page);
      if (dup) {
        db.prepare('DELETE FROM bookmarks WHERE id = ?').run(dup.id);
        return { removed: true, id: dup.id };
      }
      return null;
    },

    insertBookmark(row) {
      const id = row.id || crypto.randomUUID();
      const now = row.created_at || new Date().toISOString();
      db.prepare(`
        INSERT INTO bookmarks (id, book_id, page, kind, label, category, color, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        row.book_id,
        row.page,
        row.kind || 'ribbon',
        row.label || '',
        row.category || 'کلیدی',
        row.color || 'amber',
        row.note || '',
        now
      );
      return db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
    },

    updateBookmark(id, patch) {
      const clean = sanitizePatch(patch, BOOKMARK_NUMERIC_FIELDS, BOOKMARK_STRING_FIELDS);
      const sets = [];
      const vals = [];
      for (const key of ['label', 'category', 'color', 'note', 'page']) {
        if (Object.hasOwn(clean, key)) {
          sets.push(`${key} = ?`);
          vals.push(clean[key]);
        }
      }
      if (sets.length > 0) {
        vals.push(id);
        db.prepare(`UPDATE bookmarks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      return db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) || null;
    },

    deleteBookmark(id) {
      db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
    },

    insertHighlight(row) {
      const id = row.id || crypto.randomUUID();
      const now = row.created_at || new Date().toISOString();
      db.prepare(`
        INSERT INTO highlights (id, book_id, page, kind, color, quote_text, note, rects_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        row.book_id,
        row.page,
        normalizeHighlightKind(row.kind),
        row.color || 'amber',
        row.quote_text || '',
        row.note || '',
        JSON.stringify(row.rects || []),
        now,
        row.updated_at || now
      );
      const saved = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
      return { ...saved, rects: JSON.parse(saved.rects_json) };
    },

    updateHighlight(id, patch) {
      const clean = sanitizePatch(patch, [], HIGHLIGHT_STRING_FIELDS);
      const sets = ['updated_at = ?'];
      const vals = [new Date().toISOString()];
      for (const key of ['color', 'note', 'quote_text']) {
        if (Object.hasOwn(clean, key)) {
          sets.push(`${key} = ?`);
          vals.push(clean[key]);
        }
      }
      const inkRects = inkRectsPatch(patch, this.getHighlight(id));
      if (inkRects) {
        sets.push('rects_json = ?');
        vals.push(JSON.stringify(inkRects));
      }
      vals.push(id);
      db.prepare(`UPDATE highlights SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      const row = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
      return row ? { ...row, rects: JSON.parse(row.rects_json) } : null;
    },

    getHighlight(id) {
      const row = db.prepare('SELECT * FROM highlights WHERE id = ?').get(id);
      return row ? { ...row, rects: JSON.parse(row.rects_json) } : null;
    },

    deleteHighlight(id) {
      db.prepare('DELETE FROM highlights WHERE id = ?').run(id);
    },

    insertTocEntry(row) {
      const id = row.id || crypto.randomUUID();
      const now = row.created_at || new Date().toISOString();
      db.prepare(`
        INSERT INTO toc_entries (id, book_id, title, page, level, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, row.book_id, row.title, row.page, Number(row.level) || 0, Number(row.sort_order) || 0, now);
      return db.prepare('SELECT * FROM toc_entries WHERE id = ?').get(id);
    },

    deleteTocEntry(id) {
      db.prepare('DELETE FROM toc_entries WHERE id = ?').run(id);
    },

    close() {
      try {
        db.close();
      } catch {}
    },
  };
}

function trySeedJsonFromSqlite(sqlitePath) {
  if (!fs.existsSync(sqlitePath)) return null;
  try {
    const queryJson = (table) => {
      const out = execFileSync('sqlite3', ['-json', sqlitePath, `SELECT * FROM ${table};`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return JSON.parse(out || '[]');
    };
    return {
      books: queryJson('books'),
      bookmarks: queryJson('bookmarks'),
      highlights: queryJson('highlights'),
      toc_entries: queryJson('toc_entries'),
    };
  } catch {
    return null;
  }
}

// Exported for tests (the JSON fallback is only picked at runtime when node:sqlite is missing).
export function createJsonStore(dataDir, booksDir) {
  const jsonPath = path.join(dataDir, 'library.json');
  const sqlitePath = path.join(dataDir, 'library.sqlite');

  let state = { books: [], bookmarks: [], highlights: [], toc_entries: [] };

  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      state = {
        books: Array.isArray(parsed.books) ? parsed.books : [],
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
        toc_entries: Array.isArray(parsed.toc_entries) ? parsed.toc_entries : [],
      };
    } catch {}
  } else {
    const seeded = trySeedJsonFromSqlite(sqlitePath);
    if (seeded) {
      state = seeded;
      fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2), 'utf8');
    }
  }

  let writeQueue = Promise.resolve();
  function persist() {
    const payload = JSON.stringify(state, null, 2);
    writeQueue = writeQueue.then(async () => {
      const tmpPath = `${jsonPath}.${process.pid}.tmp`;
      await fsp.writeFile(tmpPath, payload, 'utf8');
      await fsp.rename(tmpPath, jsonPath);
    }).catch(() => {});
  }

  return {
    engine: 'json',
    dataDir,
    booksDir,

    listBooks() {
      const hlCount = new Map();
      const bmCount = new Map();
      for (const h of state.highlights) {
        hlCount.set(h.book_id, (hlCount.get(h.book_id) || 0) + 1);
      }
      for (const b of state.bookmarks) {
        bmCount.set(b.book_id, (bmCount.get(b.book_id) || 0) + 1);
      }
      return [...state.books]
        .sort((a, b) => String(b.last_opened_at).localeCompare(String(a.last_opened_at)) || String(b.created_at).localeCompare(String(a.created_at)))
        .map((b) => ({
          ...b,
          highlight_count: hlCount.get(b.id) || 0,
          bookmark_count: bmCount.get(b.id) || 0,
        }));
    },

    getBook(id) {
      return state.books.find((b) => b.id === id) || null;
    },

    insertBook(row) {
      const book = {
        id: row.id,
        title: row.title,
        author: row.author || '',
        format: row.format || 'pdf',
        filename: row.filename,
        file_path: row.file_path,
        file_size: row.file_size,
        total_pages: row.total_pages || 0,
        current_page: 1,
        scroll_ratio: 0,
        zoom_mode: 'fit-width',
        zoom_scale: row.zoom_scale ?? 1.25,
        view_mode: 'scroll',
        page_theme: 'paper',
        reading_dir: row.reading_dir || 'rtl',
        warmth: 0,
        brightness: 100,
        reading_seconds: 0,
        cover_data_url: row.cover_data_url || '',
        created_at: row.created_at,
        last_opened_at: row.last_opened_at,
      };
      state.books.push(book);
      persist();
      return { ...book };
    },

    updateBook(id, patch) {
      const book = state.books.find((b) => b.id === id);
      if (!book) return null;
      const allowed = [
        'title', 'author', 'total_pages', 'current_page', 'scroll_ratio',
        'zoom_mode', 'zoom_scale', 'view_mode', 'page_theme', 'reading_dir',
        'warmth', 'brightness', 'reading_seconds', 'cover_data_url', 'last_opened_at',
      ];
      const clean = sanitizePatch(patch, BOOK_NUMERIC_FIELDS, BOOK_STRING_FIELDS);
      for (const key of allowed) {
        if (Object.hasOwn(clean, key)) {
          book[key] = clean[key];
        }
      }
      persist();
      return { ...book };
    },

    deleteBook(id) {
      const idx = state.books.findIndex((b) => b.id === id);
      if (idx === -1) return null;
      const [removed] = state.books.splice(idx, 1);
      state.bookmarks = state.bookmarks.filter((b) => b.book_id !== id);
      state.highlights = state.highlights.filter((h) => h.book_id !== id);
      state.toc_entries = state.toc_entries.filter((t) => t.book_id !== id);
      persist();
      return removed;
    },

    getBookFull(bookId) {
      const book = this.getBook(bookId);
      if (!book) return null;
      const bookmarks = state.bookmarks
        .filter((b) => b.book_id === bookId)
        .sort((a, b) => a.page - b.page || String(a.created_at).localeCompare(String(b.created_at)));
      const highlights = state.highlights
        .filter((h) => h.book_id === bookId)
        .sort((a, b) => a.page - b.page || String(a.created_at).localeCompare(String(b.created_at)))
        .map((h) => ({ ...h, rects: JSON.parse(h.rects_json) }));
      const tocEntries = state.toc_entries
        .filter((t) => t.book_id === bookId)
        .sort((a, b) => a.page - b.page || (a.sort_order || 0) - (b.sort_order || 0));
      return { book: { ...book }, bookmarks, highlights, tocEntries };
    },

    toggleRibbonBookmark(bookId, page) {
      const idx = state.bookmarks.findIndex((b) => b.book_id === bookId && b.page === page && b.kind === 'ribbon');
      if (idx !== -1) {
        const [removed] = state.bookmarks.splice(idx, 1);
        persist();
        return { removed: true, id: removed.id };
      }
      return null;
    },

    insertBookmark(row) {
      const bm = {
        id: row.id || crypto.randomUUID(),
        book_id: row.book_id,
        page: row.page,
        kind: row.kind || 'ribbon',
        label: row.label || '',
        category: row.category || 'کلیدی',
        color: row.color || 'amber',
        note: row.note || '',
        created_at: row.created_at || new Date().toISOString(),
      };
      state.bookmarks.push(bm);
      persist();
      return { ...bm };
    },

    updateBookmark(id, patch) {
      const bm = state.bookmarks.find((b) => b.id === id);
      if (!bm) return null;
      const clean = sanitizePatch(patch, BOOKMARK_NUMERIC_FIELDS, BOOKMARK_STRING_FIELDS);
      for (const key of ['label', 'category', 'color', 'note', 'page']) {
        if (Object.hasOwn(clean, key)) bm[key] = clean[key];
      }
      persist();
      return { ...bm };
    },

    deleteBookmark(id) {
      state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
      persist();
    },

    insertHighlight(row) {
      const now = row.created_at || new Date().toISOString();
      const hl = {
        id: row.id || crypto.randomUUID(),
        book_id: row.book_id,
        page: row.page,
        kind: normalizeHighlightKind(row.kind),
        color: row.color || 'amber',
        quote_text: row.quote_text || '',
        note: row.note || '',
        rects_json: JSON.stringify(row.rects || []),
        created_at: now,
        updated_at: row.updated_at || now,
      };
      state.highlights.push(hl);
      persist();
      return { ...hl, rects: JSON.parse(hl.rects_json) };
    },

    updateHighlight(id, patch) {
      const hl = state.highlights.find((h) => h.id === id);
      if (!hl) return null;
      hl.updated_at = new Date().toISOString();
      const clean = sanitizePatch(patch, [], HIGHLIGHT_STRING_FIELDS);
      for (const key of ['color', 'note', 'quote_text']) {
        if (Object.hasOwn(clean, key)) hl[key] = clean[key];
      }
      const inkRects = inkRectsPatch(patch, hl);
      if (inkRects) hl.rects_json = JSON.stringify(inkRects);
      persist();
      return { ...hl, rects: JSON.parse(hl.rects_json) };
    },

    getHighlight(id) {
      const hl = state.highlights.find((h) => h.id === id);
      return hl ? { ...hl, rects: JSON.parse(hl.rects_json) } : null;
    },

    deleteHighlight(id) {
      state.highlights = state.highlights.filter((h) => h.id !== id);
      persist();
    },

    insertTocEntry(row) {
      const entry = {
        id: row.id || crypto.randomUUID(),
        book_id: row.book_id,
        title: row.title,
        page: row.page,
        level: Number(row.level) || 0,
        sort_order: Number(row.sort_order) || 0,
        created_at: row.created_at || new Date().toISOString(),
      };
      state.toc_entries.push(entry);
      persist();
      return { ...entry };
    },

    deleteTocEntry(id) {
      state.toc_entries = state.toc_entries.filter((t) => t.id !== id);
      persist();
    },

    close() {
      // Write-through queue flushes naturally
    },
  };
}

export async function openLibraryStore(dataDir) {
  const booksDir = path.join(dataDir, 'books');
  fs.mkdirSync(booksDir, { recursive: true });

  if (sqliteMod?.DatabaseSync) {
    return createSqliteStore(dataDir, booksDir);
  }
  return createJsonStore(dataDir, booksDir);
}
