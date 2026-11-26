import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseEpubSummary,
  getEpubChapter,
  openZipArchive,
  _sanitizeForTest,
} from '../lib/epub-parser.mjs';
import { buildSampleEpubBuffer } from '../scripts/generate-sample-book.mjs';

function writeTempEpub(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-epub-test-'));
  const file = path.join(dir, 'sample.epub');
  fs.writeFileSync(file, buf);
  return { dir, file };
}

test('parseEpubSummary reads a sample EPUB from a file path', async () => {
  const { dir, file } = writeTempEpub(buildSampleEpubBuffer());
  try {
    const summary = await parseEpubSummary(file);
    assert.ok(summary.title.length > 0, 'title should be set');
    assert.ok(summary.totalChapters >= 1, 'at least one chapter');
    assert.equal(summary.chapters.length, summary.totalChapters);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getEpubChapter returns HTML for chapter 1', async () => {
  const { dir, file } = writeTempEpub(buildSampleEpubBuffer());
  try {
    const chapter = await getEpubChapter(file, 'test-book', 1);
    assert.equal(chapter.page, 1);
    assert.equal(typeof chapter.html, 'string');
    assert.ok(chapter.html.includes('<h1'), 'html should contain the chapter heading');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openZipArchive works with a Buffer and close() is a no-op', () => {
  const archive = openZipArchive(buildSampleEpubBuffer());
  try {
    assert.equal(archive.hasEntry('mimetype'), true);
    assert.equal(archive.readEntryText('mimetype'), 'application/epub+zip');
    assert.equal(archive.readEntryText('META-INF/container.xml').includes('container'), true);
  } finally {
    archive.close();
  }
});

test('openZipArchive reads entries from a file path lazily and close() releases the fd', () => {
  const { dir, file } = writeTempEpub(buildSampleEpubBuffer());
  try {
    const archive = openZipArchive(file);
    assert.equal(archive.readEntryText('mimetype'), 'application/epub+zip');
    archive.close();
    assert.throws(() => archive.readEntryBuffer('mimetype'), /بسته شده/);
    archive.close(); // idempotent
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry larger than maxEntryBytes throws instead of returning data', () => {
  const archive = openZipArchive(buildSampleEpubBuffer(), { maxEntryBytes: 10 });
  try {
    assert.throws(() => archive.readEntryBuffer('OEBPS/ch1.xhtml'), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.length > 0);
      return true;
    });
  } finally {
    archive.close();
  }
});

test('too many entries is rejected', () => {
  assert.throws(() => openZipArchive(buildSampleEpubBuffer(), { maxEntries: 1 }), (err) => err instanceof Error);
});

test('sanitizer removes <img/onerror=...> handler', () => {
  const out = _sanitizeForTest('<body><img/onerror=alert(1) src=x></body>', 'OEBPS/ch1.xhtml', 'b', new Map());
  assert.equal(/onerror/i.test(out), false, `handler leaked: ${out}`);
  assert.equal(out.includes('alert'), false, `payload leaked: ${out}`);
});

test('sanitizer neutralizes javascript: in svg xlink:href', () => {
  const out = _sanitizeForTest(
    '<body><svg><a xlink:href="javascript:alert(1)">x</a></svg></body>',
    'OEBPS/ch1.xhtml',
    'b',
    new Map()
  );
  assert.equal(/javascript:/i.test(out), false, `javascript: leaked: ${out}`);
});

test('sanitizer strips unclosed script/iframe opening tags', () => {
  const out = _sanitizeForTest('<body><p>hi</p><script src=evil.js><iframe src=x>', 'OEBPS/ch1.xhtml', 'b', new Map());
  assert.equal(/<\s*(script|iframe)/i.test(out), false, `tag leaked: ${out}`);
  assert.ok(out.includes('hi'));
});
