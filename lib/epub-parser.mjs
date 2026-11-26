// Node adapter for the shared EPUB core (public/js/epub-core.js).
// Owns only what is environment-specific: fd-based byte reads, zlib inflate,
// `/api/books/:id/epub-asset/...` URL resolution and the parsed-archive cache.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  EXT_MIME,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  buildChapter,
  createEntryLookup,
  decodeXmlEntities,
  inflatedTooLargeError,
  locateZipEntryData,
  normalizePersianText,
  normalizeZipPath,
  parseEpubPackage,
  parseZipDirectory,
  rewriteCssSync,
  sanitizeChapterMarkupSync,
  searchChapters,
  summarizeParsed,
  truncatedEntryError,
  unsupportedCompressionError,
} from '../public/js/epub-core.js';

export { decodeXmlEntities, normalizePersianText, MAX_ZIP_ENTRY_BYTES, MAX_ZIP_ENTRIES };

/**
 * Node.js ZIP reader. The central directory is parsed by the shared core; only the
 * byte reads and the inflate step live here.
 *
 * File paths are read lazily: only the EOCD tail, the central directory and the
 * requested entries are read from the file descriptor. Call `close()` when done.
 * Buffers are accepted as before; `close()` is a no-op for them.
 *
 * options.maxEntryBytes: max declared/inflated size per entry (default 64 MiB)
 * options.maxEntries: max entry count (default 20000)
 */
export function openZipArchive(filePathOrBuffer, options = {}) {
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;

  const isBuffer = Buffer.isBuffer(filePathOrBuffer);
  let fd = null;
  let buf = null;
  let fileSize;
  if (isBuffer) {
    buf = filePathOrBuffer;
    fileSize = buf.length;
  } else {
    fd = fs.openSync(filePathOrBuffer, 'r');
    try {
      fileSize = fs.fstatSync(fd).size;
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  function closeFd() {
    if (fd !== null) {
      const handle = fd;
      fd = null;
      fs.closeSync(handle);
    }
  }

  function readAt(position, length) {
    if (buf) return buf.subarray(position, position + length);
    if (fd === null) throw new Error('آرشیو ZIP بسته شده است.');
    const out = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, out, got, length - got, position + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? out : out.subarray(0, got);
  }

  try {
    const entries = parseZipDirectory(fileSize, readAt, { maxEntries });
    const { has: hasEntry, findInsensitive: findEntryInsensitive } = createEntryLookup(entries);

    function readEntryBuffer(entryName) {
      const key = findEntryInsensitive(entryName);
      if (!key) return null;
      const entry = entries.get(key);
      const { start, length, method } = locateZipEntryData(entry, key, fileSize, readAt, maxEntryBytes);
      const slice = readAt(start, length);
      if (slice.length !== length) throw truncatedEntryError(key);

      if (method === 0) {
        return Buffer.from(slice);
      }
      if (method === 8) {
        try {
          return zlib.inflateRawSync(slice, { maxOutputLength: maxEntryBytes });
        } catch (err) {
          if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) {
            throw inflatedTooLargeError(key);
          }
          throw err;
        }
      }
      throw unsupportedCompressionError(method, key);
    }

    function readEntryText(entryName) {
      const b = readEntryBuffer(entryName);
      return b ? b.toString('utf8') : null;
    }

    return {
      entries,
      hasEntry,
      findEntryInsensitive,
      readEntryBuffer,
      readEntryText,
      close: closeFd,
    };
  } catch (err) {
    closeFd();
    throw err;
  }
}

/** Wrap an openZipArchive() result in the minimal archive interface the core expects. */
function toCoreArchive(zip) {
  return {
    has: (name) => zip.hasEntry(name),
    findInsensitive: (name) => zip.findEntryInsensitive(name),
    readText: async (name) => zip.readEntryText(name),
    readBytes: async (name) => zip.readEntryBuffer(name),
  };
}

function encodeAssetRoute(bookId, resolvedZipPath) {
  const encodedSegs = normalizeZipPath(resolvedZipPath)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `/api/books/${encodeURIComponent(bookId)}/epub-asset/${encodedSegs}`;
}

/** Test hook: synchronous sanitize + rewrite with server asset routes. */
export function _sanitizeForTest(rawXhtml, chapterPath, bookId, pathToPageMap) {
  return sanitizeChapterMarkupSync(rawXhtml, chapterPath, pathToPageMap, (p) => encodeAssetRoute(bookId, p));
}

// LRU cache keyed by `${filePath}:${mtimeMs}:${size}`; evicted archives get their fd closed.
const MAX_SUMMARY_CACHE_ENTRIES = 8;
const summaryCache = new Map();

function closeCachedEntry(entry) {
  try {
    entry?.archive?.close?.();
  } catch {
    // ignore close errors; the fd is already gone
  }
}

async function getCachedParsedEpub(filePath) {
  const stat = await fsp.stat(filePath);
  const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  const existing = summaryCache.get(cacheKey);
  if (existing) {
    // refresh recency
    summaryCache.delete(cacheKey);
    summaryCache.set(cacheKey, existing);
    return existing;
  }

  // Same file, older mtime: stale parse, release its fd now.
  for (const [key, cached] of [...summaryCache]) {
    if (cached.filePath === filePath && cached.mtimeMs < stat.mtimeMs) {
      closeCachedEntry(cached);
      summaryCache.delete(key);
    }
  }

  let archive = null;
  let parsed;
  let core;
  try {
    archive = openZipArchive(filePath);
    core = toCoreArchive(archive);
    parsed = await parseEpubPackage(core);
  } catch (err) {
    closeCachedEntry({ archive });
    throw err;
  }

  while (summaryCache.size >= MAX_SUMMARY_CACHE_ENTRIES) {
    const firstKey = summaryCache.keys().next().value;
    closeCachedEntry(summaryCache.get(firstKey));
    summaryCache.delete(firstKey);
  }

  const entry = { archive, core, parsed, filePath, mtimeMs: stat.mtimeMs };
  summaryCache.set(cacheKey, entry);
  return entry;
}

export async function parseEpubSummary(filePath) {
  const { parsed } = await getCachedParsedEpub(filePath);
  return summarizeParsed(parsed);
}

export async function getEpubChapter(filePath, bookId, chapterNum) {
  const { core, parsed } = await getCachedParsedEpub(filePath);
  return buildChapter(core, parsed, chapterNum, (p) => encodeAssetRoute(bookId, p));
}

export async function getEpubAsset(filePath, bookId, assetRelPath) {
  const { archive } = await getCachedParsedEpub(filePath);
  const cleanRel = normalizeZipPath(decodeURIComponent(assetRelPath));
  const resolvedKey = archive.findEntryInsensitive(cleanRel);
  if (!resolvedKey) return null;

  const buf = archive.readEntryBuffer(resolvedKey);
  if (!buf) return null;

  const ext = path.posix.extname(resolvedKey).toLowerCase();
  const mimeType = EXT_MIME[ext] || 'application/octet-stream';

  if (ext === '.css') {
    const rewritten = rewriteCssSync(buf.toString('utf8'), resolvedKey, '.epub-chapter-body', (p) =>
      encodeAssetRoute(bookId, p)
    );
    return { buffer: Buffer.from(rewritten, 'utf8'), mimeType };
  }

  return { buffer: buf, mimeType };
}

export async function searchEpubBook(filePath, query, limit = 120) {
  const { core, parsed } = await getCachedParsedEpub(filePath);
  return searchChapters(core, parsed, query, limit);
}
