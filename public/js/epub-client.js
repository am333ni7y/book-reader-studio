// Pure Browser ESM ZIP + EPUB 2/3 Parser (Android APK / Offline WebView)
import { normalizePersianText } from './bilingual-text.js';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

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
};

function normalizeZipPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function dirnamePosix(p) {
  const norm = normalizeZipPath(p);
  const idx = norm.lastIndexOf('/');
  return idx === -1 ? '.' : norm.slice(0, idx);
}

function normalizePosix(p) {
  const parts = normalizeZipPath(p).split('/');
  const out = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

function resolvePosixRelative(baseFile, relRef) {
  const cleanRef = String(relRef || '').split('#')[0].split('?')[0].trim();
  if (!cleanRef) return normalizeZipPath(baseFile);
  if (cleanRef.startsWith('/')) return normalizePosix(cleanRef);
  const baseDir = dirnamePosix(baseFile);
  return normalizePosix(baseDir === '.' ? cleanRef : `${baseDir}/${cleanRef}`);
}

function extnamePosix(p) {
  const base = normalizeZipPath(p).split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function decodeXmlEntities(str) {
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

function parseAttributes(attrStr) {
  const attrs = {};
  if (!attrStr) return attrs;
  const re = /([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1].toLowerCase()] = decodeXmlEntities(m[2] ?? m[3] ?? m[4] ?? '');
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
  const clean = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|blockquote|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizePersianText(
    decodeXmlEntities(clean)
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
  );
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Same caps as lib/epub-parser.mjs (MAX_ZIP_ENTRY_BYTES / MAX_ZIP_ENTRIES)
const CLIENT_ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const CLIENT_ZIP_MAX_ENTRIES = 20000;

export async function openClientZipArchive(blobOrBuffer) {
  const buf = blobOrBuffer instanceof Uint8Array
    ? blobOrBuffer
    : new Uint8Array(await blobOrBuffer.arrayBuffer());

  if (buf.byteLength < 22) {
    throw new Error('فایل EPUB معتبر نیست.');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const minOffset = Math.max(0, buf.byteLength - 65557);
  let eocdOffset = -1;

  for (let i = buf.byteLength - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === buf.byteLength) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ساختار مرکزی ZIP در فایل EPUB پیدا نشد.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (totalEntries > CLIENT_ZIP_MAX_ENTRIES) {
    throw new Error(`تعداد فایل‌های EPUB از حد مجاز (${CLIENT_ZIP_MAX_ENTRIES}) بیشتر است.`);
  }
  const entries = new Map();

  let ptr = cdOffset;
  for (let i = 0; i < totalEntries && ptr + 46 <= buf.byteLength; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(ptr + 10, true);
    const compressedSize = view.getUint32(ptr + 20, true);
    const uncompressedSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localHeaderOffset = view.getUint32(ptr + 42, true);

    const rawName = utf8Decoder.decode(buf.subarray(ptr + 46, ptr + 46 + nameLen));
    const name = normalizeZipPath(rawName);
    if (name && !name.endsWith('/')) {
      entries.set(name, { name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
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

  async function readEntryBytes(entryName) {
    const key = findEntryInsensitive(entryName);
    if (!key) return null;
    const entry = entries.get(key);
    const lh = entry.localHeaderOffset;
    if (lh + 30 > buf.byteLength || view.getUint32(lh, true) !== 0x04034b50) {
      throw new Error(`هدر فایل در آرشیو نامعتبر است: ${key}`);
    }
    const lfNameLen = view.getUint16(lh + 26, true);
    const lfExtraLen = view.getUint16(lh + 28, true);
    const dataStart = lh + 30 + lfNameLen + lfExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buf.byteLength) {
      throw new Error(`داده فایل در آرشیو ناقص است: ${key}`);
    }

    if (entry.uncompressedSize > CLIENT_ZIP_MAX_ENTRY_BYTES || entry.compressedSize > CLIENT_ZIP_MAX_ENTRY_BYTES) {
      throw new Error(`اندازه فایل داخل EPUB از حد مجاز بیشتر است: ${key}`);
    }

    const slice = buf.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) {
      return slice;
    }
    if (entry.compressionMethod === 8) {
      if (typeof DecompressionStream !== 'function') {
        throw new Error('مرورگر از DecompressionStream پشتیبانی نمی‌کند.');
      }
      const reader = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > CLIENT_ZIP_MAX_ENTRY_BYTES) {
            throw new Error(`فایل داخل EPUB پس از باز شدن از حد مجاز بزرگ‌تر است: ${key}`);
          }
          chunks.push(value);
        }
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    }
    throw new Error(`روش فشرده‌سازی ZIP پشتیبانی نمی‌شود: ${entry.compressionMethod}`);
  }

  async function readEntryText(entryName) {
    const bytes = await readEntryBytes(entryName);
    return bytes ? utf8Decoder.decode(bytes) : null;
  }

  return { entries, findEntryInsensitive, readEntryBytes, readEntryText };
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
      if (m[1] === '/') level = Math.max(-1, level - 1);
      else {
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

async function parseEpubArchiveClient(archive) {
  const containerXml = await archive.readEntryText('META-INF/container.xml');
  if (!containerXml) throw new Error('فایل EPUB فاقد META-INF/container.xml است.');

  const rootfileMatch = containerXml.match(/<rootfile\b([^>]*)\/?>/i);
  const rootAttrs = parseAttributes(rootfileMatch?.[1] || '');
  const opfPath = normalizeZipPath(rootAttrs['full-path'] || '');
  if (!opfPath) throw new Error('مسیر OPF در فایل EPUB پیدا نشد.');

  const opfXml = await archive.readEntryText(opfPath);
  if (!opfXml) throw new Error(`فایل OPF پیدا نشد: ${opfPath}`);

  const titleMatch = opfXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i);
  const creatorMatch = opfXml.match(/<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const langMatch = opfXml.match(/<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i);

  const title = normalizePersianText(decodeXmlEntities((titleMatch?.[1] || '').replace(/<[^>]+>/g, '')));
  const author = normalizePersianText(decodeXmlEntities((creatorMatch?.[1] || '').replace(/<[^>]+>/g, '')));
  const language = decodeXmlEntities((langMatch?.[1] || '').replace(/<[^>]+>/g, '')).trim().toLowerCase();

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
  if (chapters.length === 0) throw new Error('فایل EPUB هیچ فصل قابل خواندنی ندارد.');

  let toc = [];
  if (navItem) {
    const navHtml = await archive.readEntryText(navItem.resolvedPath);
    if (navHtml) toc = parseNavToc(navHtml, navItem.resolvedPath, pathToPageMap);
  }
  if (toc.length === 0 && ncxItem) {
    const ncxXml = await archive.readEntryText(ncxItem.resolvedPath);
    if (ncxXml) toc = parseNcxToc(ncxXml, ncxItem.resolvedPath, pathToPageMap);
  }

  let readingDir = 'ltr';
  const ppd = (spineAttrs['page-progression-direction'] || '').toLowerCase();
  if (ppd === 'rtl' || ppd === 'ltr') {
    readingDir = ppd;
  } else if (/^(fa|ar|he|ur|ps|ku)\b/.test(language)) {
    readingDir = 'rtl';
  } else {
    const sampleChapter = (await archive.readEntryText(chapters[Math.min(1, chapters.length - 1)].resolvedPath)) || '';
    if (detectTextDirection(stripTagsToText(sampleChapter)) === 'rtl') readingDir = 'rtl';
  }

  let coverDataUrl = '';
  if (coverItem) {
    const coverBuf = await archive.readEntryBytes(coverItem.resolvedPath);
    if (coverBuf && coverBuf.length > 0 && coverBuf.length <= 1.5 * 1024 * 1024) {
      coverDataUrl = `data:${coverItem.mediaType};base64,${bytesToBase64(coverBuf)}`;
    }
  }

  return { title, author, language, readingDir, coverDataUrl, chapters, toc, pathToPageMap };
}

const epubSessionCache = new Map();
const epubAssetUrls = new Map();

export function releaseClientEpubAssets(bookId) {
  const urls = epubAssetUrls.get(bookId);
  if (urls) {
    for (const u of urls.values()) {
      try {
        URL.revokeObjectURL(u);
      } catch {}
    }
    epubAssetUrls.delete(bookId);
  }
  epubSessionCache.delete(bookId);
}

async function getClientEpubSession(bookId, blobOrBuffer) {
  if (epubSessionCache.has(bookId)) return epubSessionCache.get(bookId);
  const archive = await openClientZipArchive(blobOrBuffer);
  const parsed = await parseEpubArchiveClient(archive);
  const session = { archive, parsed };
  epubSessionCache.set(bookId, session);
  return session;
}

async function getAssetObjectUrl(bookId, archive, resolvedPath) {
  const key = archive.findEntryInsensitive(resolvedPath);
  if (!key) return '';
  let map = epubAssetUrls.get(bookId);
  if (!map) {
    map = new Map();
    epubAssetUrls.set(bookId, map);
  }
  if (map.has(key)) return map.get(key);
  const bytes = await archive.readEntryBytes(key);
  if (!bytes) return '';
  const mime = EXT_MIME[extnamePosix(key)] || 'application/octet-stream';
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  map.set(key, url);
  return url;
}

async function rewriteCssClient(cssText, cssBasePath, bookId, archive, scopeSelector) {
  if (!cssText) return '';
  let out = cssText.replace(/@import\s+(?:url\()?["']?https?:\/\/[^)"'\s]+["']?\)?[^;]*;/gi, '');
  const matches = [...out.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi)];
  for (const m of matches) {
    const rawUrl = m[2].trim();
    if (!rawUrl || /^(data:|blob:|https?:|#)/i.test(rawUrl)) continue;
    const resolved = resolvePosixRelative(cssBasePath, decodeURIComponent(rawUrl));
    const blobUrl = await getAssetObjectUrl(bookId, archive, resolved);
    if (blobUrl) {
      out = out.replace(m[0], `url("${blobUrl}")`);
    }
  }
  return out
    .replace(/\b(html|body)\b/gi, scopeSelector)
    .replace(/position\s*:\s*fixed\b/gi, 'position: relative')
    .replace(/height\s*:\s*100vh\b/gi, 'height: auto')
    .replace(/overflow\s*:\s*hidden\b/gi, 'overflow: visible');
}

export async function parseClientEpubSummary(blobOrBuffer) {
  const archive = await openClientZipArchive(blobOrBuffer);
  const parsed = await parseEpubArchiveClient(archive);
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

export async function getClientEpubManifest(bookId, blobOrBuffer) {
  const { parsed } = await getClientEpubSession(bookId, blobOrBuffer);
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

export async function getClientEpubChapter(bookId, blobOrBuffer, chapterNum) {
  const { archive, parsed } = await getClientEpubSession(bookId, blobOrBuffer);
  const idx = Math.max(1, Math.min(parsed.chapters.length, Number(chapterNum) || 1));
  const chapter = parsed.chapters[idx - 1];
  const rawXhtml = await archive.readEntryText(chapter.resolvedPath);
  if (rawXhtml === null) throw new Error(`فصل ${idx} در فایل EPUB پیدا نشد.`);

  const scopeSelector = `.epub-chapter-shell[data-page="${idx}"] .epub-chapter-body`;
  const cssParts = [];

  const linkRe = /<link\b([^>]*)\/?>/gi;
  let lm;
  while ((lm = linkRe.exec(rawXhtml)) !== null) {
    const attrs = parseAttributes(lm[1]);
    if ((attrs.rel || '').toLowerCase().includes('stylesheet') && attrs.href) {
      const cssPath = resolvePosixRelative(chapter.resolvedPath, decodeURIComponent(attrs.href));
      const cssRaw = await archive.readEntryText(cssPath);
      if (cssRaw) cssParts.push(await rewriteCssClient(cssRaw, cssPath, bookId, archive, scopeSelector));
    }
  }
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let sm;
  while ((sm = styleRe.exec(rawXhtml)) !== null) {
    cssParts.push(await rewriteCssClient(sm[1], chapter.resolvedPath, bookId, archive, scopeSelector));
  }

  const bodyMatch = rawXhtml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let html = (bodyMatch ? bodyMatch[1] : rawXhtml)
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(object|embed|applet|base|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(object|embed|applet|base|meta|link)\b[^>]*\/?>/gi, '')
    .replace(/<\/?(script|iframe)\b[^>]*(>|$)/gi, '')
    .replace(/(^|[\s/"'])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');

  html = html.replace(
    /(^|[\s/"'])(xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
    (full, lead, attr, dVal, sVal) => {
      const norm = decodeXmlEntities(dVal ?? sVal ?? '').replace(/[\u0000- \u007F]+/g, '').toLowerCase();
      if (norm.startsWith('javascript:') || norm.startsWith('vbscript:')) return `${lead}${attr}="#"`;
      return full;
    }
  );

  const assetMatches = [...html.matchAll(/\b(src|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)];
  for (const m of assetMatches) {
    const val = (m[2] ?? m[3] ?? '').trim();
    if (!val || /^(data:|blob:|https?:|#)/i.test(val)) continue;
    const resolved = resolvePosixRelative(chapter.resolvedPath, decodeURIComponent(val));
    const blobUrl = await getAssetObjectUrl(bookId, archive, resolved);
    if (blobUrl) {
      const outAttr = m[1].toLowerCase() === 'xlink:href' ? 'href' : m[1];
      html = html.replace(m[0], `${outAttr}="${blobUrl}"`);
    }
  }

  html = html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>/gi,
    (_full, pre, dVal, sVal, post) => {
      const href = (dVal ?? sVal ?? '').trim();
      if (!href || /^javascript:/i.test(href)) return `<a${pre} href="#"${post}>`;
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        return `<a${pre} href="${href}" target="_blank" rel="noopener noreferrer"${post}>`;
      }
      const [relPart, hashPart] = href.split('#');
      const resolved = relPart ? resolvePosixRelative(chapter.resolvedPath, decodeURIComponent(relPart)) : chapter.resolvedPath;
      const targetPage = parsed.pathToPageMap.get(resolved) || parsed.pathToPageMap.get(decodeURIComponent(resolved));
      if (targetPage) {
        const anchorAttr = hashPart ? ` data-epub-anchor="${decodeURIComponent(hashPart).replace(/"/g, '&quot;')}"` : '';
        return `<a${pre} href="#epub-ch-${targetPage}" data-epub-page="${targetPage}"${anchorAttr}${post}>`;
      }
      return `<a${pre} href="#"${post}>`;
    }
  );

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

export async function searchClientEpub(bookId, blobOrBuffer, query, limit = 120) {
  const { archive, parsed } = await getClientEpubSession(bookId, blobOrBuffer);
  const q = normalizePersianText(String(query || '').trim()).toLowerCase();
  if (!q) return { matches: [], total: 0 };

  const matches = [];
  for (const ch of parsed.chapters) {
    const raw = await archive.readEntryText(ch.resolvedPath);
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

// Minimal CRC32 for building a Stored-ZIP sample EPUB completely offline in browser JS
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function createSampleEpubFile() {
  const files = [
    { name: 'mimetype', content: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    {
      name: 'OEBPS/content.opf',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">ketabkhan-sample-v3</dc:identifier>
    <dc:title>هنر مطالعه عمیق — راهنمای کتاب‌خان استودیو</dc:title>
    <dc:creator>Ketabkhan Studio</dc:creator>
    <dc:language>fa</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine page-progression-direction="rtl">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
    },
    {
      name: 'OEBPS/nav.xhtml',
      content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="fa" dir="rtl"><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">فصل اول: مطالعه عمیق آفلاین</a></li><li><a href="ch2.xhtml">فصل دوم: هایلایت و خروجی Obsidian</a></li></ol></nav></body></html>`,
    },
    {
      name: 'OEBPS/ch1.xhtml',
      content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="fa" dir="rtl"><body><h1>فصل اول: مطالعه عمیق آفلاین</h1><p>خوش آمدید! این کتاب نمونه به صورت کامل و آفلاین داخل <strong>کتاب‌خان استودیو</strong> اجرا می‌شود.</p><p>می‌توانید همین جمله را انتخاب و هایلایت کنید یا به <a href="ch2.xhtml">فصل دوم</a> بروید.</p></body></html>`,
    },
    {
      name: 'OEBPS/ch2.xhtml',
      content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="fa" dir="rtl"><body><h1>فصل دوم: هایلایت و خروجی Obsidian</h1><p>تمام هایلایت‌ها، بوکمارک‌ها و یادداشت‌های شما به صورت محلی ذخیره می‌شوند و با یک کلیک به فرمت Markdown برای <strong>Obsidian</strong> خروجی گرفته می‌شوند.</p></body></html>`,
    },
  ];

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = utf8Encoder.encode(f.name);
    const data = utf8Encoder.encode(f.content);
    const crc = crc32(data);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);

    locals.push(lh, data);
    centrals.push(cd);
    offset += lh.length + data.length;
  }

  const cdBytes = concatBytes(centrals);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, offset, true);

  const zipBytes = concatBytes([...locals, cdBytes, eocd]);
  return new File([zipBytes], 'ketabkhan-sample.epub', { type: 'application/epub+zip' });
}
