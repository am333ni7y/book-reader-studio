import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer, mergeObsidianNote } from '../server.mjs';

// node:http lets us set Host and Origin explicitly (fetch forbids overriding Host).
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
  return fs.mkdtempSync(path.join(os.tmpdir(), `ketab-test-${label}-`));
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n%%EOF');

async function uploadPdf(port, title = '') {
  const headers = { 'Content-Type': 'application/pdf', 'x-book-filename': encodeURIComponent('sample.pdf') };
  if (title) headers['x-book-title'] = encodeURIComponent(title);
  const res = await rawRequest({ port, method: 'POST', urlPath: '/api/books', headers, body: PDF_BYTES });
  assert.equal(res.status, 201, `upload failed: ${res.body}`);
  return json(res).book;
}

describe('ketabkhan server (loopback)', () => {
  let ctx;
  let dataDir;
  let obsidianDir;

  before(async () => {
    dataDir = makeTempDir('data');
    obsidianDir = makeTempDir('notes');
    ctx = await startServer({ host: '127.0.0.1', port: 0, dataDir, obsidianDir });
  });

  after(async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx.store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(obsidianDir, { recursive: true, force: true });
  });

  test('forged Host header is rejected with 403', async () => {
    const res = await rawRequest({ port: ctx.port, urlPath: '/api/health', headers: { Host: 'evil.example' } });
    assert.equal(res.status, 403);
    assert.ok(json(res).error);
  });

  test('loopback Host header is accepted', async () => {
    const res = await rawRequest({ port: ctx.port, urlPath: '/api/health', headers: { Host: `127.0.0.1:${ctx.port}` } });
    assert.equal(res.status, 200);
  });

  test('cross-origin text/plain POST to import-path is not accepted', async () => {
    const payload = JSON.stringify({ filePath: path.join(dataDir, 'nope.pdf') });
    const res = await rawRequest({
      port: ctx.port,
      method: 'POST',
      urlPath: '/api/books/import-path',
      headers: { 'Content-Type': 'text/plain', Origin: 'http://evil.example' },
      body: payload,
    });
    assert.ok([403, 415].includes(res.status), `expected 403 or 415, got ${res.status}`);
    assert.notEqual(res.status, 201);
  });

  test('text/plain body without Origin is rejected with 415', async () => {
    const res = await rawRequest({
      port: ctx.port,
      method: 'POST',
      urlPath: '/api/books/import-path',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"filePath":"x"}',
    });
    assert.equal(res.status, 415);
  });

  test('malformed JSON body returns 400', async () => {
    const res = await rawRequest({
      port: ctx.port,
      method: 'POST',
      urlPath: '/api/books/import-path',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(res.status, 400);
  });

  test('PATCH with object value returns 200 and ignores the value', async () => {
    const seeded = await rawRequest({ port: ctx.port, method: 'POST', urlPath: '/api/books/seed' });
    assert.equal(seeded.status, 201);
    const book = json(seeded).book;
    const before = await rawRequest({ port: ctx.port, urlPath: `/api/books/${book.id}` });
    const currentBefore = json(before).book.current_page;

    const res = await rawRequest({
      port: ctx.port,
      method: 'PATCH',
      urlPath: `/api/books/${book.id}`,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_page: { a: 1 }, title: 'Renamed' }),
    });
    assert.equal(res.status, 200);
    const updated = json(res).book;
    assert.equal(updated.current_page, currentBefore);
    assert.equal(updated.title, 'Renamed');
  });

  test('suffix Range bytes=-10 returns 206 with the last 10 bytes', async () => {
    const book = await uploadPdf(ctx.port);
    const res = await rawRequest({ port: ctx.port, urlPath: `/api/books/${book.id}/file`, headers: { Range: 'bytes=-10' } });
    assert.equal(res.status, 206);
    assert.equal(res.body.length, 10);
    assert.deepEqual(res.body, PDF_BYTES.subarray(PDF_BYTES.length - 10));
    assert.equal(res.headers['content-range'], `bytes ${PDF_BYTES.length - 10}-${PDF_BYTES.length - 1}/${PDF_BYTES.length}`);
  });

  test('two books with the same title export to different files', async () => {
    const a = await uploadPdf(ctx.port, 'Same Title');
    const b = await uploadPdf(ctx.port, 'Same Title');
    assert.notEqual(a.id, b.id);

    const resA = await rawRequest({ port: ctx.port, method: 'POST', urlPath: `/api/books/${a.id}/export-obsidian` });
    const resB = await rawRequest({ port: ctx.port, method: 'POST', urlPath: `/api/books/${b.id}/export-obsidian` });
    assert.equal(resA.status, 200);
    assert.equal(resB.status, 200);
    const pathA = json(resA).savedPath;
    const pathB = json(resB).savedPath;
    assert.notEqual(pathA, pathB);
    assert.equal(json(resA).filename, `Same Title - ${a.id.slice(0, 8)}.md`);
    assert.ok(fs.existsSync(pathA) && fs.existsSync(pathB));
  });

  test('re-export keeps user text placed outside the managed markers', async () => {
    const book = await uploadPdf(ctx.port, 'Keep Notes');
    const first = await rawRequest({ port: ctx.port, method: 'POST', urlPath: `/api/books/${book.id}/export-obsidian` });
    const savedPath = json(first).savedPath;
    fs.appendFileSync(savedPath, '\nMY PERSONAL NOTE\n', 'utf8');

    const second = await rawRequest({ port: ctx.port, method: 'POST', urlPath: `/api/books/${book.id}/export-obsidian` });
    assert.equal(second.status, 200);
    const text = fs.readFileSync(savedPath, 'utf8');
    assert.ok(text.includes('MY PERSONAL NOTE'));
    assert.equal(text.split('<!-- ketabkhan:start -->').length, 2);
  });
});

describe('mergeObsidianNote', () => {
  const newFm = '---\ntitle: "new"\n---\n';
  const newBody = '\n# New\n\nGENERATED\n';

  test('keeps user text outside the markers and replaces the block', () => {
    const existing = [
      '---',
      'title: "old"',
      '---',
      'USER BEFORE',
      '<!-- ketabkhan:start -->',
      'OLD GENERATED',
      '<!-- ketabkhan:end -->',
      'USER AFTER',
      '',
    ].join('\n');
    const merged = mergeObsidianNote(existing, newFm, newBody);
    assert.ok(merged.startsWith('---\ntitle: "new"\n---\n'));
    assert.ok(merged.includes('USER BEFORE'));
    assert.ok(merged.includes('USER AFTER'));
    assert.ok(merged.includes('GENERATED'));
    assert.ok(!merged.includes('OLD GENERATED'));
    assert.ok(!merged.includes('title: "old"'));
  });

  test('file without markers is overwritten', () => {
    const merged = mergeObsidianNote('plain old text', newFm, newBody);
    assert.ok(merged.includes('<!-- ketabkhan:start -->'));
    assert.ok(!merged.includes('plain old text'));
  });

  test('empty existing text produces a wrapped note', () => {
    const merged = mergeObsidianNote('', newFm, newBody);
    assert.equal(merged.startsWith(newFm + '<!-- ketabkhan:start -->'), true);
    assert.ok(merged.includes('<!-- ketabkhan:end -->'));
  });
});

describe('ketabkhan server (LAN token mode)', () => {
  let ctx;
  let dataDir;
  let obsidianDir;
  const TOKEN = 'lan-test-token-123';
  let previousEnv;

  before(async () => {
    previousEnv = process.env.KETABKHAN_TOKEN;
    process.env.KETABKHAN_TOKEN = TOKEN;
    dataDir = makeTempDir('lan-data');
    obsidianDir = makeTempDir('lan-notes');
    ctx = await startServer({ host: '0.0.0.0', port: 0, dataDir, obsidianDir });
  });

  after(async () => {
    await new Promise((resolve) => ctx.server.close(resolve));
    ctx.store.close();
    if (previousEnv === undefined) delete process.env.KETABKHAN_TOKEN;
    else process.env.KETABKHAN_TOKEN = previousEnv;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(obsidianDir, { recursive: true, force: true });
  });

  test('returns the configured token', () => {
    assert.equal(ctx.token, TOKEN);
    assert.equal(ctx.lan, true);
  });

  test('/api/books without token returns 401', async () => {
    const res = await rawRequest({ port: ctx.port, urlPath: '/api/books' });
    assert.equal(res.status, 401);
  });

  test('/api/books with x-ketabkhan-token header returns 200', async () => {
    const res = await rawRequest({ port: ctx.port, urlPath: '/api/books', headers: { 'x-ketabkhan-token': TOKEN } });
    assert.equal(res.status, 200);
  });

  test('/api/books with wrong token returns 401', async () => {
    const res = await rawRequest({ port: ctx.port, urlPath: '/api/books', headers: { 'x-ketabkhan-token': 'nope' } });
    assert.equal(res.status, 401);
  });

  test('page request with ?token= redirects and sets the cookie', async () => {
    const res = await rawRequest({ port: ctx.port, urlPath: `/?token=${TOKEN}` });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
    const cookie = String(res.headers['set-cookie']?.[0] || '');
    assert.ok(cookie.startsWith(`ketabkhan_token=${TOKEN}`));
    assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict') && cookie.includes('Path=/'));
  });

  test('/api/books with ketabkhan_token cookie returns 200', async () => {
    const res = await rawRequest({
      port: ctx.port,
      urlPath: '/api/books',
      headers: { Cookie: `ketabkhan_token=${TOKEN}` },
    });
    assert.equal(res.status, 200);
  });
});
