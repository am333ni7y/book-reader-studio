import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const RTL_RE = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
const LATIN_RE = /[A-Za-z]/g;

const EXT_MIME = {
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

function normalizeZipPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function resolvePosixRelative(baseFile, relRef) {
  const cleanRef = String(relRef || '').split('#')[0].split('?')[0].trim();
  if (!cleanRef) return normalizeZipPath(baseFile);
  if (cleanRef.startsWith('/')) return normalizeZipPath(cleanRef);
  const baseDir = path.posix.dirname(normalizeZipPath(baseFile));
  const joined = baseDir === '.' ? cleanRef : path.posix.join(baseDir, cleanRef);
  return normalizeZipPath(path.posix.normalize(joined));
}

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

export function normalizePersianText(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFKC')
    .replace(/\u064A/g, '\u06CC')
    .replace(/\u0643/g, '\u06A9')
    .replace(/\u06C0/g, '\u0647\u0654')
    .replace(/\u200B|\uFEFF/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function parseAttributes(attrStr) {
  const attrs = {};
  if (!attrStr) return attrs;
  const re = /([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    attrs[key] = decodeXmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function detectTextDirection(text) {
  const rtl = (text.match(RTL_RE) || []).length;
  const lat = (text.match(LATIN_RE) || []).length;
  if (rtl === 0 && lat === 0) return 'auto';
  return rtl > lat * 0.35 ? 'rtl' : 'ltr';
}

function stripTagsToText(html) {
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

/**
 * Pure Node.js ZIP reader using Central Directory + End of Central Directory (EOCD).
 * Immune to bit-3 data descriptors because data offset is read from Local File Header.
 */
export function openZipArchive(filePathOrBuffer) {
  const buf = Buffer.isBuffer(filePathOrBuffer)
    ? filePathOrBuffer
    : fs.readFileSync(filePathOrBuffer);

  if (buf.length < 22) {
    throw new Error('فایل ZIP/EPUB معتبر نیست (حجم کمتر از حد مجاز).');
  }

  // Locate EOCD signature 0x06054b50 searching backward up to 65557 bytes
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ساختار مرکزی ZIP در فایل EPUB پیدا نشد.');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = new Map();
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries && ptr + 46 <= buf.length; i++) {
    const sig = buf.readUInt32LE(ptr);
    if (sig !== 0x02014b50) break;

    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const uncompressedSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);

    const rawName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    const name = normalizeZipPath(rawName);
    if (name && !name.endsWith('/')) {
      entries.set(name, {
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  function hasEntry(entryName) {
    return entries.has(normalizeZipPath(entryName));
  }

  function findEntryInsensitive(entryName) {
    const norm = normalizeZipPath(entryName);
    if (entries.has(norm)) return norm;
    const lower = norm.toLowerCase();
    for (const k of entries.keys()) {
      if (k.toLowerCase() === lower) return k;
    }
    return null;
  }

  function readEntryBuffer(entryName) {
    const key = findEntryInsensitive(entryName);
    if (!key) return null;
    const entry = entries.get(key);
    const lh = entry.localHeaderOffset;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
      throw new Error(`هدر محلی فایل در آرشیو نامعتبر است: ${key}`);
    }
    const lfNameLen = buf.readUInt16LE(lh + 26);
    const lfExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lfNameLen + lfExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buf.length) {
      throw new Error(`داده فشرده‌شده فایل ناقص است: ${key}`);
    }
    const slice = buf.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) {
      return Buffer.from(slice);
    }
    if (entry.compressionMethod === 8) {
      return zlib.inflateRawSync(slice);
    }
    throw new Error(`روش فشرده‌سازی ZIP پشتیبانی نمی‌شود (${entry.compressionMethod}): ${key}`);
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
  };
}

function parseNavToc(navHtml, navPath, pathToPageMap) {
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
    const page = pathToPageMap.get(resolved) || pathToPageMap.get(decodeURIComponent(resolved));
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

function parseNcxToc(ncxXml, ncxPath, pathToPageMap) {
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
      const page = pathToPageMap.get(resolved) || pathToPageMap.get(decodeURIComponent(resolved));
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

function parseEpubArchive(archive) {
  const containerXml = archive.readEntryText('META-INF/container.xml');
  if (!containerXml) {
    throw new Error('فایل EPUB فاقد META-INF/container.xml است.');
  }

  const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?>/i);
  const rootAttrs = parseAttributes(rootfileMatch?.[1] || '');
  const opfPath = normalizeZipPath(rootAttrs['full-path'] || '');
  if (!opfPath) {
    throw new Error('مسیر package OPF در فایل EPUB پیدا نشد.');
  }

  const opfXml = archive.readEntryText(opfPath);
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
    const navHtml = archive.readEntryText(navItem.resolvedPath);
    if (navHtml) toc = parseNavToc(navHtml, navItem.resolvedPath, pathToPageMap);
  }
  if (toc.length === 0 && ncxItem) {
    const ncxXml = archive.readEntryText(ncxItem.resolvedPath);
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
    const sampleChapter = archive.readEntryText(chapters[Math.min(1, chapters.length - 1)].resolvedPath) || '';
    const sampleText = stripTagsToText(sampleChapter);
    if (detectTextDirection(sampleText) === 'rtl') readingDir = 'rtl';
  }

  // Cover data URL (<= 1.5MB)
  let coverDataUrl = '';
  if (coverItem) {
    const coverBuf = archive.readEntryBuffer(coverItem.resolvedPath);
    if (coverBuf && coverBuf.length > 0 && coverBuf.length <= 1.5 * 1024 * 1024) {
      coverDataUrl = `data:${coverItem.mediaType};base64,${coverBuf.toString('base64')}`;
    }
  }

  return {
    title,
    author,
    language,
    readingDir,
    coverDataUrl,
    chapters,
    toc,
    pathToPageMap,
    manifest,
  };
}

function encodeAssetRoute(bookId, resolvedZipPath) {
  const encodedSegs = normalizeZipPath(resolvedZipPath)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `/api/books/${encodeURIComponent(bookId)}/epub-asset/${encodedSegs}`;
}

function rewriteCssUrlsAndScope(cssText, cssBasePath, bookId, scopeSelector) {
  if (!cssText) return '';
  let out = cssText
    .replace(/@import\s+(?:url\()?["']?https?:\/\/[^)"'\s]+["']?\)?[^;]*;/gi, '')
    .replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (full, q, rawUrl) => {
      const trimmed = rawUrl.trim();
      if (!trimmed || /^(data:|blob:|https?:|#)/i.test(trimmed)) return full;
      const resolved = resolvePosixRelative(cssBasePath, decodeURIComponent(trimmed));
      return `url("${encodeAssetRoute(bookId, resolved)}")`;
    });

  // Neutralize page-breaking viewport rules from raw EPUB CSS
  out = out
    .replace(/\b(html|body)\b/gi, scopeSelector)
    .replace(/position\s*:\s*fixed\b/gi, 'position: relative')
    .replace(/height\s*:\s*100vh\b/gi, 'height: auto')
    .replace(/overflow\s*:\s*hidden\b/gi, 'overflow: visible');

  return out;
}

function sanitizeAndRewriteChapterMarkup(rawXhtml, chapterPath, bookId, pathToPageMap) {
  const bodyMatch = rawXhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let html = bodyMatch ? bodyMatch[1] : rawXhtml;

  // Server-side defense-in-depth stripping of active/executable tags & event handlers
  html = html
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet|base|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(object|embed|applet|base|meta|link)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Rewrite src / poster / xlink:href to /api/books/:id/epub-asset/...
  html = html.replace(
    /\b(src|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (full, attr, dVal, sVal) => {
      const val = (dVal ?? sVal ?? '').trim();
      if (!val || /^(data:|blob:|https?:|#)/i.test(val)) return full;
      const resolved = resolvePosixRelative(chapterPath, decodeURIComponent(val));
      const assetUrl = encodeAssetRoute(bookId, resolved);
      const outAttr = attr.toLowerCase() === 'xlink:href' ? 'href' : attr;
      return `${outAttr}="${assetUrl}"`;
    }
  );

  // Rewrite <a href="..."> for internal spine navigation vs safe external links
  html = html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>/gi,
    (full, pre, dVal, sVal, post) => {
      const href = (dVal ?? sVal ?? '').trim();
      if (!href || /^javascript:/i.test(href)) {
        return `<a${pre} href="#"${post}>`;
      }
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        return `<a${pre} href="${href}" target="_blank" rel="noopener noreferrer"${post}>`;
      }
      const [relPart, hashPart] = href.split('#');
      const resolved = relPart ? resolvePosixRelative(chapterPath, decodeURIComponent(relPart)) : chapterPath;
      const targetPage = pathToPageMap.get(resolved) || pathToPageMap.get(decodeURIComponent(resolved));
      if (targetPage) {
        const anchorAttr = hashPart ? ` data-epub-anchor="${decodeURIComponent(hashPart).replace(/"/g, '&quot;')}"` : '';
        return `<a${pre} href="#epub-ch-${targetPage}" data-epub-page="${targetPage}"${anchorAttr}${post}>`;
      }
      return `<a${pre} href="#"${post}>`;
    }
  );

  return html;
}

// Simple LRU-ish cache keyed by `${filePath}:${mtimeMs}`
const summaryCache = new Map();

async function getCachedParsedEpub(filePath) {
  const stat = await fsp.stat(filePath);
  const cacheKey = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  const existing = summaryCache.get(cacheKey);
  if (existing) return existing;

  const archive = openZipArchive(filePath);
  const parsed = parseEpubArchive(archive);
  const entry = { archive, parsed };
  if (summaryCache.size > 16) {
    const firstKey = summaryCache.keys().next().value;
    summaryCache.delete(firstKey);
  }
  summaryCache.set(cacheKey, entry);
  return entry;
}

export async function parseEpubSummary(filePath) {
  const { parsed } = await getCachedParsedEpub(filePath);
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

export async function getEpubChapter(filePath, bookId, chapterNum) {
  const { archive, parsed } = await getCachedParsedEpub(filePath);
  const idx = Math.max(1, Math.min(parsed.chapters.length, Number(chapterNum) || 1));
  const chapter = parsed.chapters[idx - 1];
  const rawXhtml = archive.readEntryText(chapter.resolvedPath);
  if (rawXhtml === null) {
    throw new Error(`فصل ${idx} در فایل EPUB پیدا نشد.`);
  }

  const scopeSelector = `.epub-chapter-shell[data-page="${idx}"] .epub-chapter-body`;
  const cssParts = [];

  // Extract linked stylesheets
  const linkRe = /<link\b([^>]*)\/?>/gi;
  let lm;
  while ((lm = linkRe.exec(rawXhtml)) !== null) {
    const attrs = parseAttributes(lm[1]);
    if ((attrs.rel || '').toLowerCase().includes('stylesheet') && attrs.href) {
      const cssPath = resolvePosixRelative(chapter.resolvedPath, decodeURIComponent(attrs.href));
      const cssRaw = archive.readEntryText(cssPath);
      if (cssRaw) {
        cssParts.push(rewriteCssUrlsAndScope(cssRaw, cssPath, bookId, scopeSelector));
      }
    }
  }

  // Extract inline <style>
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(rawXhtml)) !== null) {
    cssParts.push(rewriteCssUrlsAndScope(sm[1], chapter.resolvedPath, bookId, scopeSelector));
  }

  const html = sanitizeAndRewriteChapterMarkup(rawXhtml, chapter.resolvedPath, bookId, parsed.pathToPageMap);
  const plainText = stripTagsToText(rawXhtml);
  const detectedDir = detectTextDirection(plainText);
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
    const rewritten = rewriteCssUrlsAndScope(buf.toString('utf8'), resolvedKey, bookId, '.epub-chapter-body');
    return { buffer: Buffer.from(rewritten, 'utf8'), mimeType };
  }

  return { buffer: buf, mimeType };
}

export async function searchEpubBook(filePath, query, limit = 120) {
  const { archive, parsed } = await getCachedParsedEpub(filePath);
  const q = normalizePersianText(String(query || '').trim()).toLowerCase();
  if (!q) return { matches: [], total: 0 };

  const matches = [];
  for (const ch of parsed.chapters) {
    const raw = archive.readEntryText(ch.resolvedPath);
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
