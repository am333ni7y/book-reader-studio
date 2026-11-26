// Shared, environment-agnostic EPUB/ZIP core.
//
// Used by the Node server adapter (lib/epub-parser.mjs) and the browser/Android
// adapter (public/js/epub-client.js). Pure ES module: no Node imports, no DOM.
// Only TextDecoder, DataView, btoa and standard JS are used.
//
// Environment-specific parts that stay in the adapters:
//   - byte I/O (fd reads vs in-memory buffer), inflate (zlib vs DecompressionStream)
//   - asset URL resolution (server routes vs blob: object URLs)
//   - caches and lifetime management
//
// Archive interface consumed by the package/chapter/search routines:
//   {
//     has(name): boolean,
//     findInsensitive(name): string | null,       // canonical entry key
//     readText(name): Promise<string | null>,     // null when the entry is missing
//     readBytes(name): Promise<Uint8Array | null> // null when the entry is missing
//   }
//
// Asset resolver: (resolvedZipPath) => string | '' | null | Promise<...>. A falsy
// result leaves the original reference untouched.
import { normalizePersianText } from './bilingual-text.js';

export { normalizePersianText };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EXT_MIME = {
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ncx': 'application/x-dtbncx+xml',
  '.opf': 'application/oebps-package+xml',
};

/** Maximum declared (and inflated) size of one ZIP entry. */
export const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
/** Maximum number of entries accepted in one archive. */
export const MAX_ZIP_ENTRIES = 20000;

const RTL_RE = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g;
const LATIN_RE = /[A-Za-z]/g;

const ZIP64_MESSAGE =
  'فرمت ZIP64 پشتیبانی نمی‌شود (ZIP64 is not supported). فایل EPUB را با ZIP استاندارد دوباره بسته‌بندی کنید.';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function normalizeZipPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/** Same semantics as path.posix.dirname for already-normalized zip paths. */
export function dirnamePosix(p) {
  const norm = normalizeZipPath(p);
  const idx = norm.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  return norm.slice(0, idx);
}

/** Same semantics as path.posix.normalize (keeps leading ".." of relative paths and a trailing slash). */
export function normalizePosix(p) {
  const input = String(p || '');
  if (input === '') return '.';
  const isAbs = input.startsWith('/');
  const trailing = input.endsWith('/');
  const out = [];
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(seg);
    }
  }
  let res = out.join('/');
  if (!res && !isAbs) res = '.';
  if (res && trailing) res += '/';
  return (isAbs ? '/' : '') + res;
}

export function extnamePosix(p) {
  const base = normalizeZipPath(p).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function resolvePosixRelative(baseFile, relRef) {
  const cleanRef = String(relRef || '').split('#')[0].split('?')[0].trim();
  if (!cleanRef) return normalizeZipPath(baseFile);
  if (cleanRef.startsWith('/')) return normalizeZipPath(cleanRef);
  const baseDir = dirnamePosix(baseFile);
  const joined = baseDir === '.' ? cleanRef : normalizePosix(`${baseDir}/${cleanRef}`);
  return normalizeZipPath(normalizePosix(joined));
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function decodeXmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

export function parseAttributes(attrStr) {
  const attrs = {};
  if (!attrStr) return attrs;
  const re = /([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function detectTextDirection(text) {
  const rtl = (text.match(RTL_RE) || []).length;
  const lat = (text.match(LATIN_RE) || []).length;
  if (rtl === 0 && lat === 0) return 'auto';
  return rtl > lat * 0.35 ? 'rtl' : 'ltr';
}

export function stripTagsToText(html) {
  if (!html) return '';
  const withoutScripts = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|blockquote|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizePersianText(
    decodeXmlEntities(withoutScripts)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  );
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// ZIP directory parsing (pure; I/O is supplied through readAt)
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8');

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Parse EOCD + Central Directory.
 *
 * @param {number} fileSize total archive size
 * @param {(position:number, length:number) => Uint8Array} readAt synchronous byte reader
 * @param {{maxEntries?: number}} [options]
 * @returns {Map<string, {name:string, compressionMethod:number, compressedSize:number, uncompressedSize:number, localHeaderOffset:number}>}
 */
export function parseZipDirectory(fileSize, readAt, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_ZIP_ENTRIES;
  if (fileSize < 22) {
    throw new Error('فایل ZIP/EPUB معتبر نیست (حجم کمتر از حد مجاز).');
  }

  // EOCD lives in the last 65557 bytes (22 bytes + max 65535 comment).
  const tailLen = Math.min(fileSize, 65557);
  const tail = readAt(fileSize - tailLen, tailLen);
  const tv = viewOf(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      const commentLen = tv.getUint16(i + 20, true);
      if (i + 22 + commentLen === tail.length) {
        eocd = i;
        break;
      }
    }
  }
  if (eocd === -1) {
    throw new Error('ساختار مرکزی ZIP در فایل EPUB پیدا نشد.');
  }

  const totalEntries = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error(ZIP64_MESSAGE);
  }
  if (totalEntries > maxEntries) {
    throw new Error(`تعداد فایل‌های آرشیو EPUB از حد مجاز (${maxEntries}) بیشتر است.`);
  }
  if (cdOffset + cdSize > fileSize) {
    throw new Error('ساختار مرکزی ZIP در فایل EPUB ناقص است.');
  }

  const cd = readAt(cdOffset, cdSize);
  const cv = viewOf(cd);
  const entries = new Map();
  let ptr = 0;
  for (let i = 0; i < totalEntries && ptr + 46 <= cd.length; i++) {
    if (cv.getUint32(ptr, true) !== 0x02014b50) break;

    const compressionMethod = cv.getUint16(ptr + 10, true);
    const compressedSize = cv.getUint32(ptr + 20, true);
    const uncompressedSize = cv.getUint32(ptr + 24, true);
    const nameLen = cv.getUint16(ptr + 28, true);
    const extraLen = cv.getUint16(ptr + 30, true);
    const commentLen = cv.getUint16(ptr + 32, true);
    const localHeaderOffset = cv.getUint32(ptr + 42, true);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error(ZIP64_MESSAGE);
    }

    const name = normalizeZipPath(utf8.decode(cd.subarray(ptr + 46, ptr + 46 + nameLen)));
    if (name && !name.endsWith('/')) {
      entries.set(name, { name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** has / findInsensitive over a parseZipDirectory() result. */
export function createEntryLookup(entries) {
  let lowerMap = null;
  function findInsensitive(entryName) {
    const norm = normalizeZipPath(entryName);
    if (entries.has(norm)) return norm;
    if (!lowerMap) {
      lowerMap = new Map();
      for (const k of entries.keys()) {
        const l = k.toLowerCase();
        if (!lowerMap.has(l)) lowerMap.set(l, k);
      }
    }
    return lowerMap.get(norm.toLowerCase()) ?? null;
  }
  return {
    has: (entryName) => entries.has(normalizeZipPath(entryName)),
    findInsensitive,
  };
}

/**
 * Validate size limits and the local file header of an entry and return where its
 * (possibly compressed) data lives. The adapter then reads the bytes and inflates.
 */
export function locateZipEntryData(entry, key, fileSize, readAt, maxEntryBytes = MAX_ZIP_ENTRY_BYTES) {
  if (entry.uncompressedSize > maxEntryBytes || entry.compressedSize > maxEntryBytes) {
    throw new Error(`اندازه فایل داخل EPUB از حد مجاز بیشتر است: ${key}`);
  }
  const lh = entry.localHeaderOffset;
  const lhBuf = readAt(lh, 30);
  if (lhBuf.length < 30 || viewOf(lhBuf).getUint32(0, true) !== 0x04034b50) {
    throw new Error(`هدر محلی فایل در آرشیو نامعتبر است: ${key}`);
  }
  const lv = viewOf(lhBuf);
  const start = lh + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  if (start + entry.compressedSize > fileSize) {
    throw new Error(`داده فشرده‌شده فایل ناقص است: ${key}`);
  }
  return { start, length: entry.compressedSize, method: entry.compressionMethod };
}

export function truncatedEntryError(key) {
  return new Error(`داده فشرده‌شده فایل ناقص است: ${key}`);
}

export function inflatedTooLargeError(key) {
  return new Error(`فایل داخل EPUB پس از باز شدن از حد مجاز بزرگ‌تر است: ${key}`);
}

export function unsupportedCompressionError(method, key) {
  return new Error(`روش فشرده‌سازی ZIP پشتیبانی نمی‌شود (${method}): ${key}`);
}

// ---------------------------------------------------------------------------
// TOC parsing
// ---------------------------------------------------------------------------

function lookupPage(pathToPageMap, resolved) {
  return pathToPageMap.get(resolved) || pathToPageMap.get(decodeURIComponent(resolved));
}

export function parseNavToc(navHtml, navPath, pathToPageMap) {
  const navMatch =
    navHtml.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i) ||
    navHtml.match(/<nav\b[^>]*role\s*=\s*["']doc-toc["'][^>]*>([\s\S]*?)<\/nav>/i) ||
    navHtml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i);
  if (!navMatch) return [];

  const body = navMatch[1];
  const toc = [];
  let level = -1;
  const tokenRe = /<(\/?)(ol|ul)\b[^>]*>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = tokenRe.exec(body)) !== null) {
    if (m[2]) {
      level += m[1] === '/' ? -1 : 1;
      continue;
    }
    const attrs = parseAttributes(m[3]);
    const href = attrs.href || '';
    const title = normalizePersianText(stripTagsToText(m[4]));
    if (!title || !href) continue;

    const [relPart, hashPart] = href.split('#');
    const resolved = relPart ? resolvePosixRelative(navPath, relPart) : navPath;
    const page = lookupPage(pathToPageMap, resolved);
    if (page) {
      toc.push({
        title,
        page,
        anchor: hashPart ? decodeURIComponent(hashPart) : '',
        level: Math.max(0, Math.min(3, level)),
        isNative: true,
      });
    }
  }
  return toc;
}

export function parseNcxToc(ncxXml, ncxPath, pathToPageMap) {
  const toc = [];
  let level = -1;
  let pendingLabel = '';
  const tokenRe = /<(\/?)navPoint\b[^>]*>|<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<\/navLabel>|<content\b([^>]*)\/?>/gi;
  let m;
  while ((m = tokenRe.exec(ncxXml)) !== null) {
    if (m[1] !== undefined && m[0].toLowerCase().includes('navpoint')) {
      if (m[1] === '/') {
        level = Math.max(-1, level - 1);
      } else {
        level += 1;
        pendingLabel = '';
      }
      continue;
    }
    if (m[2] !== undefined) {
      pendingLabel = normalizePersianText(decodeXmlEntities(m[2].replace(/<[^>]+>/g, '')));
      continue;
    }
    if (m[3] !== undefined) {
      const attrs = parseAttributes(m[3]);
      const src = attrs.src || '';
      if (!src || !pendingLabel) continue;
      const [relPart, hashPart] = src.split('#');
      const resolved = resolvePosixRelative(ncxPath, relPart);
      const page = lookupPage(pathToPageMap, resolved);
      if (page) {
        toc.push({
          title: pendingLabel,
          page,
          anchor: hashPart ? decodeURIComponent(hashPart) : '',
          level: Math.max(0, Math.min(3, level)),
          isNative: true,
        });
      }
      pendingLabel = '';
    }
  }
  return toc;
}

// ---------------------------------------------------------------------------
// Package (OPF) parsing
// ---------------------------------------------------------------------------

/**
 * Parse container.xml + OPF + TOC for an archive.
 * @returns {Promise<{title:string, author:string, language:string, readingDir:'ltr'|'rtl',
 *   coverDataUrl:string, chapters:Array, toc:Array, pathToPageMap:Map, manifest:Map}>}
 */
export async function parseEpubPackage(archive) {
  const containerXml = await archive.readText('META-INF/container.xml');
  if (!containerXml) {
    throw new Error('فایل EPUB فاقد META-INF/container.xml است.');
  }

  const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?>/i);
  const rootAttrs = parseAttributes(rootfileMatch?.[1] || '');
  const opfPath = normalizeZipPath(rootAttrs['full-path'] || '');
  if (!opfPath) {
    throw new Error('مسیر package OPF در فایل EPUB پیدا نشد.');
  }

  const opfXml = await archive.readText(opfPath);
  if (!opfXml) {
    throw new Error(`فایل OPF در آرشیو پیدا نشد: ${opfPath}`);
  }

  const titleMatch = opfXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
  const creatorMatch = opfXml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const langMatch = opfXml.match(/<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i);

  const title = normalizePersianText(decodeXmlEntities((titleMatch?.[1] || '').replace(/<[^>]+>/g, '')));
  const author = normalizePersianText(decodeXmlEntities((creatorMatch?.[1] || '').replace(/<[^>]+>/g, '')));
  const language = decodeXmlEntities((langMatch?.[1] || '').replace(/<[^>]+>/g, '')).trim().toLowerCase();

  // Manifest items
  const manifest = new Map();
  let navItem = null;
  let ncxItem = null;
  let coverItem = null;

  const itemRe = /<item\b([^>]*)\/?>/gi;
  let im;
  while ((im = itemRe.exec(opfXml)) !== null) {
    const attrs = parseAttributes(im[1]);
    if (!attrs.id || !attrs.href) continue;
    const resolvedPath = resolvePosixRelative(opfPath, decodeURIComponent(attrs.href));
    const entry = {
      id: attrs.id,
      href: attrs.href,
      resolvedPath,
      mediaType: (attrs['media-type'] || '').toLowerCase(),
      properties: (attrs.properties || '').toLowerCase(),
    };
    manifest.set(attrs.id, entry);

    if (entry.properties.split(/\s+/).includes('nav')) navItem = entry;
    if (entry.mediaType === 'application/x-dtbncx+xml') ncxItem = entry;
    if (entry.properties.split(/\s+/).includes('cover-image')) coverItem = entry;
  }

  // EPUB 2 cover meta fallback
  if (!coverItem) {
    const coverMetaRe = /<meta\b([^>]*)\/?>/gi;
    let cm;
    while ((cm = coverMetaRe.exec(opfXml)) !== null) {
      const attrs = parseAttributes(cm[1]);
      if (attrs.name === 'cover' && attrs.content && manifest.has(attrs.content)) {
        const candidate = manifest.get(attrs.content);
        if (candidate.mediaType.startsWith('image/')) {
          coverItem = candidate;
          break;
        }
      }
    }
  }
  if (!coverItem) {
    for (const entry of manifest.values()) {
      if (entry.mediaType.startsWith('image/') && /cover/i.test(`${entry.id} ${entry.href}`)) {
        coverItem = entry;
        break;
      }
    }
  }

  // Spine
  const spineMatch = opfXml.match(/<spine\b([^>]*)>([\s\S]*?)<\/spine>/i);
  const spineAttrs = parseAttributes(spineMatch?.[1] || '');
  const spineBody = spineMatch?.[2] || '';
  if (!ncxItem && spineAttrs.toc && manifest.has(spineAttrs.toc)) {
    ncxItem = manifest.get(spineAttrs.toc);
  }

  const chapters = [];
  const pathToPageMap = new Map();
  const itemrefRe = /<itemref\b([^>]*)\/?>/gi;
  let ir;
  while ((ir = itemrefRe.exec(spineBody)) !== null) {
    const attrs = parseAttributes(ir[1]);
    if (!attrs.idref || attrs.linear === 'no') continue;
    const mItem = manifest.get(attrs.idref);
    if (!mItem) continue;
    const pageIndex = chapters.length + 1;
    chapters.push({
      page: pageIndex,
      id: mItem.id,
      href: mItem.href,
      resolvedPath: mItem.resolvedPath,
      mediaType: mItem.mediaType,
    });
    pathToPageMap.set(mItem.resolvedPath, pageIndex);
  }

  if (chapters.length === 0) {
    throw new Error('فایل EPUB هیچ فصل قابل خواندنی در spine ندارد.');
  }

  // TOC extraction
  let toc = [];
  if (navItem) {
    const navHtml = await archive.readText(navItem.resolvedPath);
    if (navHtml) toc = parseNavToc(navHtml, navItem.resolvedPath, pathToPageMap);
  }
  if (toc.length === 0 && ncxItem) {
    const ncxXml = await archive.readText(ncxItem.resolvedPath);
    if (ncxXml) toc = parseNcxToc(ncxXml, ncxItem.resolvedPath, pathToPageMap);
  }

  // Reading direction detection
  let readingDir = 'ltr';
  const ppd = (spineAttrs['page-progression-direction'] || '').toLowerCase();
  if (ppd === 'rtl' || ppd === 'ltr') {
    readingDir = ppd;
  } else if (/^(fa|ar|he|ur|ps|ku)\b/.test(language)) {
    readingDir = 'rtl';
  } else {
    const sampleChapter = (await archive.readText(chapters[Math.min(1, chapters.length - 1)].resolvedPath)) || '';
    if (detectTextDirection(stripTagsToText(sampleChapter)) === 'rtl') readingDir = 'rtl';
  }

  // Cover data URL (<= 1.5MB)
  let coverDataUrl = '';
  if (coverItem) {
    const coverBuf = await archive.readBytes(coverItem.resolvedPath);
    if (coverBuf && coverBuf.length > 0 && coverBuf.length <= 1.5 * 1024 * 1024) {
      coverDataUrl = `data:${coverItem.mediaType};base64,${bytesToBase64(coverBuf)}`;
    }
  }

  return { title, author, language, readingDir, coverDataUrl, chapters, toc, pathToPageMap, manifest };
}

/** The public manifest/summary shape shared by both adapters. */
export function summarizeParsed(parsed) {
  return {
    title: parsed.title,
    author: parsed.author,
    language: parsed.language,
    readingDir: parsed.readingDir,
    coverDataUrl: parsed.coverDataUrl,
    totalChapters: parsed.chapters.length,
    chapters: parsed.chapters.map((c) => ({ page: c.page, id: c.id, href: c.href })),
    toc: parsed.toc,
  };
}

// ---------------------------------------------------------------------------
// CSS rewrite + scoping
// ---------------------------------------------------------------------------

const CSS_URL_RE = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;

function stripRemoteImports(cssText) {
  return cssText.replace(/@import\s+(?:url\()?["']?https?:\/\/[^)"'\s]+["']?\)?[^;]*;/gi, '');
}

function mapCssUrls(css, cssBasePath, lookup) {
  return css.replace(CSS_URL_RE, (full, _q, rawUrl) => {
    const trimmed = rawUrl.trim();
    if (!trimmed || /^(data:|blob:|https?:|#)/i.test(trimmed)) return full;
    const url = lookup(resolvePosixRelative(cssBasePath, decodeURIComponent(trimmed)));
    return url ? `url("${url}")` : full;
  });
}

/** Neutralize page-breaking viewport rules from raw EPUB CSS and scope html/body. */
function scopeCss(css, scopeSelector) {
  // Rewrite html/body only inside selector preludes (text right before "{"), never inside
  // declarations, so url("images/body.png") or font names containing "body" stay intact.
  return css
    // Lookbehind (not a capture) so the "{" of "@media ... {" is still available to the next selector.
    .replace(/(?<=^|[{}])([^{}]*)\{/g, (full, prelude) => {
      if (/^\s*@/.test(prelude)) return full;
      return `${prelude.replace(/(^|[\s,>+~(])(html|body)\b/gi, (m, lead) => `${lead}${scopeSelector}`)}{`;
    })
    .replace(/position\s*:\s*fixed\b/gi, 'position: relative')
    .replace(/height\s*:\s*100vh\b/gi, 'height: auto')
    .replace(/overflow\s*:\s*hidden\b/gi, 'overflow: visible');
}

async function resolveAllAsync(wanted, resolveAsset) {
  const urls = new Map();
  for (const p of wanted) urls.set(p, (await resolveAsset(p)) || '');
  return urls;
}

function resolveAllSync(wanted, resolveAsset) {
  const urls = new Map();
  for (const p of wanted) urls.set(p, resolveAsset(p) || '');
  return urls;
}

export function rewriteCssSync(cssText, cssBasePath, scopeSelector, resolveAsset) {
  if (!cssText) return '';
  const base = stripRemoteImports(cssText);
  const wanted = new Set();
  mapCssUrls(base, cssBasePath, (p) => (wanted.add(p), ''));
  const urls = resolveAllSync(wanted, resolveAsset);
  return scopeCss(mapCssUrls(base, cssBasePath, (p) => urls.get(p)), scopeSelector);
}

export async function rewriteCss(cssText, cssBasePath, scopeSelector, resolveAsset) {
  if (!cssText) return '';
  const base = stripRemoteImports(cssText);
  const wanted = new Set();
  mapCssUrls(base, cssBasePath, (p) => (wanted.add(p), ''));
  const urls = await resolveAllAsync(wanted, resolveAsset);
  return scopeCss(mapCssUrls(base, cssBasePath, (p) => urls.get(p)), scopeSelector);
}

// ---------------------------------------------------------------------------
// Chapter sanitizing + link rewriting
// ---------------------------------------------------------------------------

const ASSET_ATTR_RE = /\b(src|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function stripActiveContent(rawXhtml) {
  const bodyMatch = rawXhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let html = bodyMatch ? bodyMatch[1] : rawXhtml;

  // Defense-in-depth stripping of active/executable tags & event handlers
  html = html
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet|base|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(object|embed|applet|base|meta|link)\b[^>]*\/?>/gi, '')
    // unclosed <script>/<iframe> opening (or stray closing) tags
    .replace(/<\/?(script|iframe)\b[^>]*(>|$)/gi, '')
    // event handlers, also when preceded by "/", quote instead of whitespace (<img/onerror=...>)
    .replace(/(^|[\s/"'])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');

  // Neutralize javascript:/vbscript: in href, xlink:href and src (entity/whitespace obfuscation included)
  return html.replace(
    /(^|[\s/"'])(xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (full, lead, attr, dVal, sVal) => {
      const norm = decodeXmlEntities(dVal ?? sVal ?? '').replace(/[\u0000- \u007F]+/g, '').toLowerCase();
      if (norm.startsWith('javascript:') || norm.startsWith('vbscript:')) {
        return `${lead}${attr}="#"`;
      }
      return full;
    }
  );
}

function mapAssetAttrs(html, chapterPath, lookup) {
  return html.replace(ASSET_ATTR_RE, (full, attr, dVal, sVal) => {
    const val = (dVal ?? sVal ?? '').trim();
    if (!val || /^(data:|blob:|https?:|#)/i.test(val)) return full;
    const url = lookup(resolvePosixRelative(chapterPath, decodeURIComponent(val)));
    if (!url) return full;
    return `${attr.toLowerCase() === 'xlink:href' ? 'href' : attr}="${url}"`;
  });
}

function rewriteLinks(html, chapterPath, pathToPageMap) {
  return html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>/gi,
    (_full, pre, dVal, sVal, post) => {
      const href = (dVal ?? sVal ?? '').trim();
      if (!href || /^javascript:/i.test(href)) {
        return `<a${pre} href="#"${post}>`;
      }
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        return `<a${pre} href="${href}" target="_blank" rel="noopener noreferrer"${post}>`;
      }
      const [relPart, hashPart] = href.split('#');
      const resolved = relPart ? resolvePosixRelative(chapterPath, decodeURIComponent(relPart)) : chapterPath;
      const targetPage = lookupPage(pathToPageMap, resolved);
      if (targetPage) {
        const anchorAttr = hashPart ? ` data-epub-anchor="${decodeURIComponent(hashPart).replace(/"/g, '&quot;')}"` : '';
        return `<a${pre} href="#epub-ch-${targetPage}" data-epub-page="${targetPage}"${anchorAttr}${post}>`;
      }
      return `<a${pre} href="#"${post}>`;
    }
  );
}

/** Synchronous variant (resolver must be synchronous). Used by the server adapter's test hook. */
export function sanitizeChapterMarkupSync(rawXhtml, chapterPath, pathToPageMap, resolveAsset) {
  const stripped = stripActiveContent(rawXhtml);
  const wanted = new Set();
  mapAssetAttrs(stripped, chapterPath, (p) => (wanted.add(p), ''));
  const urls = resolveAllSync(wanted, resolveAsset);
  return rewriteLinks(mapAssetAttrs(stripped, chapterPath, (p) => urls.get(p)), chapterPath, pathToPageMap);
}

/** Strip active content, rewrite asset refs through the (possibly async) resolver, rewrite internal links. */
export async function sanitizeChapterMarkup(rawXhtml, chapterPath, pathToPageMap, resolveAsset) {
  const stripped = stripActiveContent(rawXhtml);
  const wanted = new Set();
  mapAssetAttrs(stripped, chapterPath, (p) => (wanted.add(p), ''));
  const urls = await resolveAllAsync(wanted, resolveAsset);
  return rewriteLinks(mapAssetAttrs(stripped, chapterPath, (p) => urls.get(p)), chapterPath, pathToPageMap);
}

// ---------------------------------------------------------------------------
// Chapter assembly and search
// ---------------------------------------------------------------------------

/**
 * Build the reader payload for chapter `chapterNum` (1-based, clamped).
 * @returns {Promise<{page:number,totalChapters:number,title:string,detectedDir:string,css:string,html:string}>}
 */
export async function buildChapter(archive, parsed, chapterNum, resolveAsset) {
  const idx = Math.max(1, Math.min(parsed.chapters.length, Number(chapterNum) || 1));
  const chapter = parsed.chapters[idx - 1];
  const rawXhtml = await archive.readText(chapter.resolvedPath);
  if (rawXhtml === null || rawXhtml === undefined) {
    throw new Error(`فصل ${idx} در فایل EPUB پیدا نشد.`);
  }

  const scopeSelector = `.epub-chapter-shell[data-page="${idx}"] .epub-chapter-body`;
  const cssParts = [];

  // Linked stylesheets
  const linkRe = /<link\b([^>]*)\/?>/gi;
  let lm;
  while ((lm = linkRe.exec(rawXhtml)) !== null) {
    const attrs = parseAttributes(lm[1]);
    if ((attrs.rel || '').toLowerCase().includes('stylesheet') && attrs.href) {
      const cssPath = resolvePosixRelative(chapter.resolvedPath, decodeURIComponent(attrs.href));
      const cssRaw = await archive.readText(cssPath);
      if (cssRaw) {
        cssParts.push(await rewriteCss(cssRaw, cssPath, scopeSelector, resolveAsset));
      }
    }
  }

  // Inline <style>
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(rawXhtml)) !== null) {
    cssParts.push(await rewriteCss(sm[1], chapter.resolvedPath, scopeSelector, resolveAsset));
  }

  const html = await sanitizeChapterMarkup(rawXhtml, chapter.resolvedPath, parsed.pathToPageMap, resolveAsset);
  const detectedDir = detectTextDirection(stripTagsToText(rawXhtml));
  const tocHit = parsed.toc.find((t) => t.page === idx);

  return {
    page: idx,
    totalChapters: parsed.chapters.length,
    title: tocHit?.title || `فصل ${idx}`,
    detectedDir: detectedDir === 'auto' ? parsed.readingDir : detectedDir,
    css: cssParts.join('\n'),
    html,
  };
}

/** Plain-text search over all chapters. */
export async function searchChapters(archive, parsed, query, limit = 120) {
  const q = normalizePersianText(String(query || '').trim()).toLowerCase();
  if (!q) return { matches: [], total: 0 };

  const matches = [];
  for (const ch of parsed.chapters) {
    const raw = await archive.readText(ch.resolvedPath);
    if (!raw) continue;
    const text = stripTagsToText(raw);
    const lower = text.toLowerCase();
    let idx = lower.indexOf(q);
    const tocHit = parsed.toc.find((t) => t.page === ch.page);
    while (idx !== -1) {
      const start = Math.max(0, idx - 36);
      const end = Math.min(text.length, idx + q.length + 54);
      const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
      matches.push({
        page: ch.page,
        chapterTitle: tocHit?.title || `فصل ${ch.page}`,
        snippet,
      });
      if (matches.length >= limit) break;
      idx = lower.indexOf(q, idx + q.length);
    }
    if (matches.length >= limit) break;
  }

  return { matches, total: matches.length };
}
