import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';
import { obsidianFilename } from '../public/js/obsidian-markdown.js';

// node:http keeps Content-Type / Host under our control (same helper shape as tests/server.test.mjs).
function rawRequest({ port, method = 'GET', urlPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'));
}

function makeTempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ketab-test-backup-${label}-`));
}

function postJson(port, urlPath, data, method = 'POST') {
  return rawRequest({
    port,
    method,
    urlPath,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function seedBook(port) {
  const res = await rawRequest({ port, method: 'POST', urlPath: '/api/books/seed' });
  assert.equal(res.status, 201, `seed failed: ${res.body}`);
  return json(res).book;
}

describe('obsidianFilename', () => {
  test('two books with the same title get different filenames', () => {
    const a = { id: '11111111-aaaa-4aaa-8aaa-000000000001', title: 'Same Title' };
    const b = { id: '22222222-bbbb-4bbb-8bbb-000000000002', title: 'Same Title' };
    const nameA = obsidianFilename(a);
    const nameB = obsidianFilename(b);
    assert.equal(nameA, 'Same Title - 11111111.md');
    assert.equal(nameB, 'Same Title - 22222222.md');
    assert.notEqual(nameA, nameB);
  });

  test('unsafe filename characters in the title are replaced', () => {
    const name = obsidianFilename({ id: 'abcdef12-0000', title: 'a/b:c*d' });
    assert.equal(name, 'a_b_c_d - abcdef12.md');
  });
});

describe('library backup export/import', () => {
  let dataA;
  let dataB;
  let notesA;
  let notesB;
  let ctxA;
  let ctxB;
  let sourceBook;
  let backup;

  before(async () => {
    dataA = makeTempDir('a');
    dataB = makeTempDir('b');
    notesA = makeTempDir('notes-a');
    notesB = makeTempDir('notes-b');
    ctxA = await startServer({ host: '127.0.0.1', port: 0, dataDir: dataA, obsidianDir: notesA });
    ctxB = await startServer({ host: '127.0.0.1', port: 0, dataDir: dataB, obsidianDir: notesB });

    // Source library: annotate the seeded book on server A and export it.
    sourceBook = await seedBook(ctxA.port);
    const patched = await postJson(ctxA.port, `/api/books/${sourceBook.id}`, { current_page: 5 }, 'PATCH');
    assert.equal(patched.status, 200, `patch failed: ${patched.body}`);

    const bm = await postJson(ctxA.port, `/api/books/${sourceBook.id}/bookmarks`, { page: 3, kind: 'pin', label: 'pin-one', note: 'n' });
    assert.equal(bm.status, 201, `bookmark failed: ${bm.body}`);

    const hl = await postJson(ctxA.port, `/api/books/${sourceBook.id}/highlights`, {
      page: 2,
      kind: 'area',
      color: 'sage',
      quote_text: '',
      note: 'hl-note',
      rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }],
    });
    assert.equal(hl.status, 201, `highlight failed: ${hl.body}`);

    const toc = await postJson(ctxA.port, `/api/books/${sourceBook.id}/toc`, { title: 'Custom section', page: 2, level: 0 });
    assert.equal(toc.status, 201, `toc failed: ${toc.body}`);

    const exported = await rawRequest({ port: ctxA.port, urlPath: '/api/library/export' });
    assert.equal(exported.status, 200);
    assert.match(String(exported.headers['content-disposition']), /attachment; filename="ketabkhan-backup-\d{4}-\d{2}-\d{2}\.json"/);
    backup = json(exported);
  });

  after(async () => {
    await new Promise((resolve) => ctxA.server.close(resolve));
    await new Promise((resolve) => ctxB.server.close(resolve));
    ctxA.store.close();
    ctxB.store.close();
    for (const dir of [dataA, dataB, notesA, notesB]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export has the documented shape and omits file paths and covers', () => {
    assert.equal(backup.format, 'ketabkhan-backup');
    assert.equal(backup.version, 1);
    assert.ok(backup.exported_at);
    assert.equal(backup.books.length, 1);
    assert.equal(backup.bookmarks.length, 1);
    assert.equal(backup.highlights.length, 1);
    assert.equal(backup.toc_entries.length, 1);
    assert.deepEqual(backup.highlights[0].rects, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }]);
    assert.equal(Object.hasOwn(backup.highlights[0], 'rects_json'), false);
    const book = backup.books[0];
    assert.equal(Object.hasOwn(book, 'file_path'), false);
    assert.equal(Object.hasOwn(book, 'cover_data_url'), false);
    assert.equal(book.current_page, 5);
  });

  test('import into a fresh library matches the book by filename and size and restores annotations', async () => {
    const target = await seedBook(ctxB.port);
    assert.notEqual(target.id, sourceBook.id);
    assert.equal(target.filename, sourceBook.filename);
    assert.equal(target.file_size, sourceBook.file_size);

    const res = await postJson(ctxB.port, '/api/library/import', backup);
    assert.equal(res.status, 200, `import failed: ${res.body}`);
    const result = json(res);
    assert.equal(result.ok, true);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.inserted, { bookmarks: 1, highlights: 1, toc_entries: 1 });

    const full = json(await rawRequest({ port: ctxB.port, urlPath: `/api/books/${target.id}` }));
    assert.equal(full.book.current_page, 5, 'reading state restored');
    assert.equal(full.bookmarks.length, 1);
    assert.equal(full.bookmarks[0].id, backup.bookmarks[0].id);
    assert.equal(full.bookmarks[0].book_id, target.id);
    assert.equal(full.highlights.length, 1);
    assert.equal(full.highlights[0].book_id, target.id);
    assert.deepEqual(full.highlights[0].rects, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.05 }]);
    assert.equal(full.tocEntries.length, 1);
    assert.equal(full.tocEntries[0].title, 'Custom section');
  });

  test('importing the same backup twice does not duplicate annotations', async () => {
    const before = await rawRequest({ port: ctxB.port, urlPath: '/api/books' });
    const targetId = json(before).books.find((b) => b.filename === sourceBook.filename).id;

    const res = await postJson(ctxB.port, '/api/library/import', backup);
    assert.equal(res.status, 200);
    const result = json(res);
    assert.equal(result.matched, 1);
    assert.deepEqual(result.inserted, { bookmarks: 0, highlights: 0, toc_entries: 0 });

    const full = json(await rawRequest({ port: ctxB.port, urlPath: `/api/books/${targetId}` }));
    assert.equal(full.bookmarks.length, 1);
    assert.equal(full.highlights.length, 1);
    assert.equal(full.tocEntries.length, 1);
  });

  test('a backup with an unknown format is rejected with 400', async () => {
    const res = await postJson(ctxB.port, '/api/library/import', { ...backup, format: 'something-else' });
    assert.equal(res.status, 400);
    assert.ok(json(res).error);
  });

  test('a backup with an unsupported version is rejected with 400', async () => {
    const res = await postJson(ctxB.port, '/api/library/import', { ...backup, version: 2 });
    assert.equal(res.status, 400);
  });

  test('a book that does not exist locally is reported as unmatched, not created', async () => {
    const foreign = {
      ...backup,
      books: [{ ...backup.books[0], id: '99999999-9999-4999-8999-999999999999', title: 'Not Here', filename: 'other.pdf', file_size: 1 }],
      bookmarks: [],
      highlights: [],
      toc_entries: [],
    };
    const res = await postJson(ctxB.port, '/api/library/import', foreign);
    assert.equal(res.status, 200);
    const result = json(res);
    assert.equal(result.matched, 0);
    assert.deepEqual(result.unmatched, ['Not Here']);

    const list = json(await rawRequest({ port: ctxB.port, urlPath: '/api/books' }));
    assert.equal(list.books.some((b) => b.title === 'Not Here'), false);
  });
});
