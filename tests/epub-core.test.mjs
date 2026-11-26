import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildChapter,
  decodeXmlEntities,
  detectTextDirection,
  normalizePosix,
  parseEpubPackage,
  parseNavToc,
  parseNcxToc,
  parseZipDirectory,
  resolvePosixRelative,
  rewriteCss,
  rewriteCssSync,
  sanitizeChapterMarkup,
  sanitizeChapterMarkupSync,
  searchChapters,
  stripTagsToText,
  summarizeParsed,
} from '../public/js/epub-core.js';
import { normalizePersianText as bilingualNormalize } from '../public/js/bilingual-text.js';
import {
  parseEpubSummary,
  getEpubChapter,
  searchEpubBook,
  normalizePersianText as serverNormalize,
  openZipArchive,
  _sanitizeForTest,
} from '../lib/epub-parser.mjs';
import {
  parseClientEpubSummary,
  getClientEpubChapter,
  getClientEpubManifest,
  searchClientEpub,
  releaseClientEpubAssets,
  openClientZipArchive,
  createSampleEpubFile,
} from '../public/js/epub-client.js';
import { buildSampleEpubBuffer, buildZipBuffer } from '../scripts/generate-sample-book.mjs';

/** Minimal archive adapter over openZipArchive (the interface the core expects). */
function coreArchiveOf(buffer) {
  const zip = openZipArchive(buffer);
  return {
    has: (n) => zip.hasEntry(n),
    findInsensitive: (n) => zip.findEntryInsensitive(n),
    readText: async (n) => zip.readEntryText(n),
    readBytes: async (n) => zip.readEntryBuffer(n),
  };
}

const route = (bookId) => (p) =>
  `/api/books/${encodeURIComponent(bookId)}/epub-asset/${p.split('/').map(encodeURIComponent).join('/')}`;

function withTempEpub(buf, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-epub-core-'));
  const file = path.join(dir, 'book.epub');
  fs.writeFileSync(file, buf);
  return Promise.resolve(fn(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------

test('normalizePersianText: server export and bilingual-text copy are the same function behaviour', () => {
  for (const s of ['ي ك  x', 'ۀ', '​ab﻿', '  a \t\t b ', '', null]) {
    assert.equal(serverNormalize(s), bilingualNormalize(s));
  }
  assert.equal(serverNormalize('ي'), 'ی');
});

test('path helpers match path.posix semantics', () => {
  for (const [base, rel] of [
    ['OEBPS/ch1.xhtml', 'img/a.png'],
    ['OEBPS/text/ch1.xhtml', '../img/a.png'],
    ['OEBPS/ch1.xhtml', '../../../a.png'],
    ['ch1.xhtml', '../a.png'],
    ['OEBPS/ch1.xhtml', '/abs/a.png'],
    ['OEBPS/ch1.xhtml', './x/./y/../z.png?v=1#frag'],
    ['OEBPS/ch1.xhtml', ''],
  ]) {
    const baseDir = path.posix.dirname(base);
    const clean = rel.split('#')[0].split('?')[0].trim();
    let expected;
    if (!clean) expected = base;
    else if (clean.startsWith('/')) expected = clean.replace(/^\/+/, '');
    else expected = path.posix.normalize(baseDir === '.' ? clean : path.posix.join(baseDir, clean));
    assert.equal(resolvePosixRelative(base, rel), expected, `${base} + ${rel}`);
  }
  for (const p of ['a/b/../c', '../a', 'a/./b/', './', '/a/../..', 'a//b']) {
    assert.equal(normalizePosix(p), path.posix.normalize(p), p);
  }
});

test('text helpers', () => {
  assert.equal(decodeXmlEntities('a&amp;b &#x41;&#66; <![CDATA[x<y]]>'), 'a&b AB x<y');
  assert.equal(detectTextDirection('سلام دنیا'), 'rtl');
  assert.equal(detectTextDirection('hello world'), 'ltr');
  assert.equal(detectTextDirection('123'), 'auto');
  assert.equal(stripTagsToText('<p>a</p><script>x()</script><p>b &amp; c</p>'), 'a\nb & c');
});

test('parseZipDirectory enforces limits and rejects ZIP64 / garbage', () => {
  const buf = buildSampleEpubBuffer();
  const readAt = (pos, len) => buf.subarray(pos, pos + len);
  const entries = parseZipDirectory(buf.length, readAt);
  assert.ok(entries.has('OEBPS/content.opf'));
  assert.throws(() => parseZipDirectory(buf.length, readAt, { maxEntries: 1 }), /از حد مجاز/);
  assert.throws(() => parseZipDirectory(10, readAt), /معتبر نیست/);
  assert.throws(() => parseZipDirectory(100, () => new Uint8Array(100)), /پیدا نشد/);

  // ZIP64 marker in EOCD (total entries = 0xFFFF)
  const z64 = Buffer.from(buf);
  const eocd = z64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  z64.writeUInt16LE(0xffff, eocd + 10);
  assert.throws(() => parseZipDirectory(z64.length, (p, l) => z64.subarray(p, p + l)), /ZIP64/);
});

test('parseEpubPackage works against an in-memory archive adapter', async () => {
  const parsed = await parseEpubPackage(coreArchiveOf(buildSampleEpubBuffer()));
  assert.match(parsed.title, /هنر مطالعه عمیق/);
  assert.equal(parsed.author, 'Ketabkhan Studio');
  assert.equal(parsed.language, 'fa');
  assert.equal(parsed.readingDir, 'rtl');
  assert.equal(parsed.chapters.length, 2);
  assert.deepEqual(parsed.chapters.map((c) => c.resolvedPath), ['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml']);
  assert.equal(parsed.toc.length, 2);
  assert.equal(parsed.toc[0].page, 1);
  assert.equal(parsed.pathToPageMap.get('OEBPS/ch2.xhtml'), 2);
  assert.ok(parsed.manifest.has('style'));
  assert.deepEqual(Object.keys(summarizeParsed(parsed)), [
    'title', 'author', 'language', 'readingDir', 'coverDataUrl', 'totalChapters', 'chapters', 'toc',
  ]);
});

test('parseNavToc / parseNcxToc resolve hrefs, anchors and nesting', () => {
  const map = new Map([['OEBPS/a.xhtml', 1], ['OEBPS/b.xhtml', 2]]);
  const nav = parseNavToc(
    '<nav epub:type="toc"><ol><li><a href="a.xhtml#s1">A</a><ol><li><a href="b.xhtml">B</a></li></ol></li></ol></nav>',
    'OEBPS/nav.xhtml',
    map
  );
  assert.deepEqual(nav.map((t) => [t.title, t.page, t.anchor, t.level]), [['A', 1, 's1', 0], ['B', 2, '', 1]]);
  const ncx = parseNcxToc(
    '<navMap><navPoint><navLabel><text>One</text></navLabel><content src="a.xhtml"/></navPoint>' +
      '<navPoint><navLabel><text>Two</text></navLabel><content src="b.xhtml#x"/></navPoint></navMap>',
    'OEBPS/toc.ncx',
    map
  );
  assert.deepEqual(ncx.map((t) => [t.title, t.page, t.anchor]), [['One', 1, ''], ['Two', 2, 'x']]);
});

// --- sanitizer ------------------------------------------------------------

const map2 = new Map([['OEBPS/ch1.xhtml', 1], ['OEBPS/ch2.xhtml', 2]]);
const sanitize = (html) => sanitizeChapterMarkupSync(html, 'OEBPS/ch1.xhtml', map2, route('b'));

test('core sanitizer: <img/onerror=...> handler removed', () => {
  const out = sanitize('<body><img/onerror=alert(1) src=x></body>');
  assert.equal(/onerror|alert/i.test(out), false, out);
});

test('core sanitizer: javascript: in svg xlink:href neutralized', () => {
  const out = sanitize('<body><svg><a xlink:href="javascript:alert(1)">x</a></svg></body>');
  assert.equal(/javascript:/i.test(out), false, out);
  const obfuscated = sanitize('<body><a href="java&#x09;script:alert(1)">x</a></body>');
  assert.equal(/script:/i.test(obfuscated), false, obfuscated);
});

test('core sanitizer: unclosed <script / <iframe stripped', () => {
  const out = sanitize('<body><p>hi</p><script src=evil.js><iframe src=x>');
  assert.equal(/<\s*(script|iframe)/i.test(out), false, out);
  assert.ok(out.includes('hi'));
  assert.equal(/<\s*(script|iframe)/i.test(sanitize('<p>x</p><script')), false);
});

test('core sanitizer: internal links become #epub-ch-N, external get rel, unknown become #', () => {
  const out = sanitize(
    '<body><a href="ch2.xhtml#a&quot;b">in</a> <a href="https://x.test/">out</a> <a href="nowhere.xhtml">no</a> <a href="">e</a></body>'
  );
  assert.match(out, /<a  href="#epub-ch-2" data-epub-page="2" data-epub-anchor="a&quot;b">in<\/a>/);
  assert.match(out, /<a  href="https:\/\/x\.test\/" target="_blank" rel="noopener noreferrer">out<\/a>/);
  assert.equal((out.match(/href="#"/g) || []).length, 2);
});

test('core sanitizer: asset refs go through the resolver; falsy result keeps the original', async () => {
  const html = '<body><img src="img/a.png"><img src="../x/b.png"><img src="data:image/png;base64,AA"><svg><image xlink:href="c.svg"/></svg></body>';
  const seen = [];
  const out = await sanitizeChapterMarkup(html, 'OEBPS/ch1.xhtml', map2, async (p) => {
    seen.push(p);
    return p === 'x/b.png' ? '' : `blob:${p}`;
  });
  assert.deepEqual(seen.sort(), ['OEBPS/c.svg', 'OEBPS/img/a.png', 'x/b.png']);
  assert.ok(out.includes('src="blob:OEBPS/img/a.png"'));
  assert.ok(out.includes('src="../x/b.png"'), 'unresolved asset keeps original attribute');
  assert.ok(out.includes('<image href="blob:OEBPS/c.svg"/>'), 'xlink:href is renamed to href');
  assert.ok(out.includes('src="data:image/png;base64,AA"'));
  // sync and async variants agree
  assert.equal(
    sanitizeChapterMarkupSync(html, 'OEBPS/ch1.xhtml', map2, (p) => (p === 'x/b.png' ? '' : `blob:${p}`)),
    out
  );
});

test('core sanitizer == server _sanitizeForTest (same resolver)', () => {
  const html = '<body onload="x()"><p onclick=a()>t</p><img src="i/p.png"><a href="ch2.xhtml">n</a></body>';
  assert.equal(
    _sanitizeForTest(html, 'OEBPS/ch1.xhtml', 'b', map2),
    sanitizeChapterMarkupSync(html, 'OEBPS/ch1.xhtml', map2, route('b'))
  );
});

// --- CSS ------------------------------------------------------------------

test('CSS: remote @import dropped, url() resolved, html/body scoped, viewport rules neutralized', async () => {
  const css =
    '@import url("https://evil.test/x.css");\nbody{background:url(img/bg.png);position:fixed;height:100vh;overflow:hidden}\n' +
    'html .a{background:url("data:image/png;base64,AA")}';
  const scope = '.epub-chapter-shell[data-page="1"] .epub-chapter-body';
  const out = rewriteCssSync(css, 'OEBPS/style.css', scope, (p) => `/r/${p}`);
  assert.equal(out.includes('evil.test'), false);
  assert.ok(out.includes('url("/r/OEBPS/img/bg.png")'));
  assert.ok(out.startsWith('\n' + scope + '{'));
  assert.ok(out.includes('position: relative'));
  assert.ok(out.includes('height: auto'));
  assert.ok(out.includes('overflow: visible'));
  assert.ok(out.includes(scope + ' .a'));
  assert.ok(out.includes('url("data:image/png;base64,AA")'));
  assert.equal(await rewriteCss(css, 'OEBPS/style.css', scope, async (p) => `/r/${p}`), out);
  assert.equal(rewriteCssSync('', 'a.css', scope, () => 'x'), '');
  // unresolved asset keeps the original url()
  assert.ok(rewriteCssSync('a{background:url(x.png)}', 'a.css', scope, () => '').includes('url(x.png)'));
});

// --- chapters, search, parity ----------------------------------------------

test('buildChapter + searchChapters on the sample EPUB', async () => {
  const buf = buildSampleEpubBuffer();
  const archive = coreArchiveOf(buf);
  const parsed = await parseEpubPackage(archive);
  const ch = await buildChapter(archive, parsed, 1, async (p) => route('x')(p));
  assert.equal(ch.page, 1);
  assert.equal(ch.totalChapters, 2);
  assert.equal(ch.detectedDir, 'rtl');
  assert.ok(ch.html.includes('<h1'));
  assert.ok(ch.css.includes('border-inline-start'));
  assert.equal(ch.title, parsed.toc[0].title);
  // clamping
  assert.equal((await buildChapter(archive, parsed, 99, route('x'))).page, 2);
  assert.equal((await buildChapter(archive, parsed, 'abc', route('x'))).page, 1);

  const hits = await searchChapters(archive, parsed, 'Obsidian');
  assert.ok(hits.total >= 1);
  assert.equal(hits.matches[0].page, 2);
  assert.deepEqual(await searchChapters(archive, parsed, '  '), { matches: [], total: 0 });
  assert.equal((await searchChapters(archive, parsed, 'e', 3)).total, 3);
});

test('parity: server adapter output equals the core output with the same resolver', async () => {
  const buf = buildSampleEpubBuffer();
  const archive = coreArchiveOf(buf);
  const parsed = await parseEpubPackage(archive);
  await withTempEpub(buf, async (file) => {
    assert.deepEqual(await parseEpubSummary(file), summarizeParsed(parsed));
    assert.deepEqual(await getEpubChapter(file, 'bk', 1), await buildChapter(archive, parsed, 1, route('bk')));
    assert.deepEqual(await getEpubChapter(file, 'bk', 2), await buildChapter(archive, parsed, 2, route('bk')));
    assert.deepEqual(await searchEpubBook(file, 'هایلایت'), await searchChapters(archive, parsed, 'هایلایت'));
  });
});

test('client adapter (Node: Blob + DecompressionStream) matches the server summary, chapters and search', async () => {
  const buf = buildSampleEpubBuffer();
  await withTempEpub(buf, async (file) => {
    const server = await parseEpubSummary(file);
    const client = await parseClientEpubSummary(new Blob([buf]));
    assert.equal(client.title, server.title);
    assert.equal(client.author, server.author);
    assert.equal(client.readingDir, server.readingDir);
    assert.equal(client.totalChapters, server.totalChapters);
    assert.deepEqual(client.toc.map((t) => t.title), server.toc.map((t) => t.title));
    assert.deepEqual(client, server);

    assert.deepEqual(await getClientEpubManifest('c1', new Blob([buf])), server);
    // No assets in the sample chapters, so html/css must be byte-identical to the server's.
    assert.deepEqual(await getClientEpubChapter('c1', new Blob([buf]), 1), await getEpubChapter(file, 'x', 1));
    assert.deepEqual(await searchClientEpub('c1', new Blob([buf]), 'Obsidian'), await searchEpubBook(file, 'Obsidian'));
    releaseClientEpubAssets('c1');
  });
});

test('client adapter resolves assets to blob: URLs and caches them; core keeps unresolved refs', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const epub = buildZipBuffer([
    { name: 'mimetype', store: true, data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    },
    {
      name: 'OEBPS/content.opf',
      data:
        '<package><metadata xmlns:dc="x"><dc:title>T</dc:title><dc:language>en</dc:language></metadata><manifest>' +
        '<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/>' +
        '<item id="img" href="img/cover.png" media-type="image/png" properties="cover-image"/>' +
        '<item id="css" href="s.css" media-type="text/css"/></manifest><spine><itemref idref="c1"/></spine></package>',
    },
    { name: 'OEBPS/img/cover.png', data: png, store: true },
    { name: 'OEBPS/s.css', data: 'body{background:url(img/cover.png)}' },
    {
      name: 'OEBPS/text/c1.xhtml',
      data: '<html><head><link rel="stylesheet" href="../s.css"/></head><body><img src="../img/cover.png"/><img src="../img/missing.png"/><p>Hello</p></body></html>',
    },
  ]);
  const summary = await parseClientEpubSummary(new Blob([epub]));
  assert.match(summary.coverDataUrl, /^data:image\/png;base64,/);
  assert.equal(summary.readingDir, 'ltr');

  const ch = await getClientEpubChapter('assets-1', new Blob([epub]), 1);
  const urls = ch.html.match(/src="(blob:[^"]+)"/g) || [];
  assert.equal(urls.length, 1, ch.html);
  assert.ok(ch.html.includes('src="../img/missing.png"'));
  assert.match(ch.css, /url\("blob:[^"]+"\)/);
  // The same asset maps to the same object URL in html and css
  assert.equal(urls[0].slice(5, -1), ch.css.match(/url\("(blob:[^"]+)"\)/)[1]);
  releaseClientEpubAssets('assets-1');

  const server = await withTempEpub(epub, async (file) => getEpubChapter(file, 'b', 1));
  assert.ok(server.html.includes('src="/api/books/b/epub-asset/OEBPS/img/cover.png"'));
  assert.ok(server.html.includes('src="/api/books/b/epub-asset/OEBPS/img/missing.png"'));
});

test('client zip reader: sample EPUB created offline can be parsed; limits and ZIP64 apply', async () => {
  const sample = createSampleEpubFile();
  const summary = await parseClientEpubSummary(sample);
  assert.equal(summary.totalChapters, 2);
  assert.equal(summary.readingDir, 'rtl');

  await assert.rejects(() => openClientZipArchive(new Uint8Array(10)), /معتبر نیست/);
  const z64 = Buffer.from(buildSampleEpubBuffer());
  z64.writeUInt16LE(0xffff, z64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) + 10);
  await assert.rejects(() => openClientZipArchive(new Uint8Array(z64)), /ZIP64/);
});

test('CSS scoping rewrites html/body selectors but not urls or declarations', async () => {
  const core = await import('../public/js/epub-core.js');
  const fn = core.rewriteCssSync;
  assert.equal(typeof fn, 'function');
  const css = 'html, body { background: url("../images/body.png"); font-family: "Body Text"; }\n@media screen { body > p { color: red } }\n.html-note { color: blue }';
  const out = fn(css, 'OEBPS/styles/a.css', '.SCOPE', (p) => `/asset/${p}`);
  assert.match(out, /\.SCOPE, \.SCOPE \{/);
  assert.match(out, /url\("\/asset\/OEBPS\/images\/body\.png"\)/);
  assert.match(out, /"Body Text"/);
  assert.match(out, /\.SCOPE > p/);
  assert.match(out, /\.html-note/);
});
