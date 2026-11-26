// Browser adapter (Android APK / offline WebView) for the shared EPUB core (epub-core.js).
// Owns only what is environment-specific: in-memory byte reads, DecompressionStream
// inflate with a size cap, blob: object-URL asset resolution and the session cache.
import {
  EXT_MIME,
  MAX_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_BYTES,
  buildChapter,
  createEntryLookup,
  extnamePosix,
  inflatedTooLargeError,
  locateZipEntryData,
  parseEpubPackage,
  parseZipDirectory,
  searchChapters,
  summarizeParsed,
  truncatedEntryError,
  unsupportedCompressionError,
} from './epub-core.js';

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

async function inflateRawCapped(slice, key) {
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
      if (total > MAX_ZIP_ENTRY_BYTES) throw inflatedTooLargeError(key);
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

export async function openClientZipArchive(blobOrBuffer) {
  const buf = blobOrBuffer instanceof Uint8Array
    ? blobOrBuffer
    : new Uint8Array(await blobOrBuffer.arrayBuffer());

  const readAt = (position, length) => buf.subarray(position, position + length);
  const entries = parseZipDirectory(buf.byteLength, readAt, { maxEntries: MAX_ZIP_ENTRIES });
  const { has: hasEntry, findInsensitive: findEntryInsensitive } = createEntryLookup(entries);

  async function readEntryBytes(entryName) {
    const key = findEntryInsensitive(entryName);
    if (!key) return null;
    const { start, length, method } = locateZipEntryData(entries.get(key), key, buf.byteLength, readAt, MAX_ZIP_ENTRY_BYTES);
    const slice = readAt(start, length);
    if (slice.length !== length) throw truncatedEntryError(key);
    if (method === 0) return slice;
    if (method === 8) return inflateRawCapped(slice, key);
    throw unsupportedCompressionError(method, key);
  }

  async function readEntryText(entryName) {
    const bytes = await readEntryBytes(entryName);
    return bytes ? utf8Decoder.decode(bytes) : null;
  }

  return { entries, hasEntry, findEntryInsensitive, readEntryBytes, readEntryText };
}

/** Wrap an openClientZipArchive() result in the minimal archive interface the core expects. */
function toCoreArchive(zip) {
  return {
    has: (name) => zip.hasEntry(name),
    findInsensitive: (name) => zip.findEntryInsensitive(name),
    readText: (name) => zip.readEntryText(name),
    readBytes: (name) => zip.readEntryBytes(name),
  };
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
  const core = toCoreArchive(archive);
  const parsed = await parseEpubPackage(core);
  const session = { archive, core, parsed };
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

export async function parseClientEpubSummary(blobOrBuffer) {
  const archive = await openClientZipArchive(blobOrBuffer);
  return summarizeParsed(await parseEpubPackage(toCoreArchive(archive)));
}

export async function getClientEpubManifest(bookId, blobOrBuffer) {
  const { parsed } = await getClientEpubSession(bookId, blobOrBuffer);
  return summarizeParsed(parsed);
}

export async function getClientEpubChapter(bookId, blobOrBuffer, chapterNum) {
  const { archive, core, parsed } = await getClientEpubSession(bookId, blobOrBuffer);
  return buildChapter(core, parsed, chapterNum, (p) => getAssetObjectUrl(bookId, archive, p));
}

export async function searchClientEpub(bookId, blobOrBuffer, query, limit = 120) {
  const { core, parsed } = await getClientEpubSession(bookId, blobOrBuffer);
  return searchChapters(core, parsed, query, limit);
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
