import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server.mjs';
import { createJsonStore } from '../lib/db-adapter.mjs';
import { buildObsidianParts } from '../public/js/obsidian-markdown.js';
import {
  normalizeHighlightKind,
  sanitizeInkRects,
  sanitizeHighlightRects,
  normalizePoint,
  thinPoints,
  pressureWidth,
  strokeOutlinePath,
  strokesHitBy,
  cropInk,
  inkToSvg,
  inkStrokes,
  inkAnchor,
  inkPageAspect,
  INK_LIMITS,
  INK_WIDTHS,
} from '../public/js/ink-core.js';

const stroke = (points, extra = {}) => ({ points, color: 'blue', width: INK_WIDTHS.m, ...extra });

describe('ink-core: stroke normalization and serialization', () => {
  test('highlight kind whitelist keeps text/area/ink and maps anything else to text', () => {
    assert.equal(normalizeHighlightKind('ink'), 'ink');
    assert.equal(normalizeHighlightKind('area'), 'area');
    assert.equal(normalizeHighlightKind('text'), 'text');
    assert.equal(normalizeHighlightKind('script'), 'text');
    assert.equal(normalizeHighlightKind(undefined), 'text');
  });

  test('normalizePoint maps client coords onto the surface and defaults missing pressure to 0.5', () => {
    const rect = { left: 100, top: 50, width: 400, height: 800 };
    assert.deepEqual(normalizePoint(300, 450, 0.8, rect), [0.5, 0.5, 0.8]);
    assert.deepEqual(normalizePoint(0, 2000, 0, rect), [0, 1, 0.5], 'clamped, zero pressure -> 0.5');
    assert.deepEqual(normalizePoint(100, 50, Number.NaN, rect), [0, 0, 0.5]);
  });

  test('sanitizeInkRects clamps coordinates, rounds, drops junk and keeps a leading meta entry only', () => {
    const out = sanitizeInkRects([
      { mode: 'page', aspect: 1.3 },
      stroke([[1.5, -0.2, 2], [0.123456789, 0.5, 0.3], ['x', 1], [0.2]]),
      { mode: 'epub-anchor', start: 5 }, // meta not at index 0 -> not a stroke, dropped
      stroke([], {}),
      'nope',
      stroke([[0.1, 0.1]], { color: 'javascript:alert(1)', width: 999 }),
    ]);
    assert.deepEqual(out[0], { mode: 'page', aspect: 1.3 });
    assert.deepEqual(out[1].points, [[1, 0, 1], [0.1235, 0.5, 0.3]]);
    assert.equal(out[1].color, 'blue');
    assert.equal(out.length, 3);
    assert.equal(out[2].color, 'black', 'unknown colour falls back to black');
    assert.equal(out[2].width, 40, 'width is capped');
    assert.deepEqual(out[2].points, [[0.1, 0.1, 0.5]]);
  });

  test('sanitizeInkRects returns null when no stroke survives', () => {
    assert.equal(sanitizeInkRects([]), null);
    assert.equal(sanitizeInkRects([{ mode: 'page', aspect: 1 }]), null);
    assert.equal(sanitizeInkRects('x'), null);
    assert.equal(sanitizeHighlightRects('ink', [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }]), null);
  });

  test('EPUB anchor is normalized (integer offsets, end >= start, sane aspect)', () => {
    const out = sanitizeInkRects([{ mode: 'epub-anchor', start: 12.7, end: 3, aspect: 99 }, stroke([[0.5, 0.5, 0.5]])]);
    assert.deepEqual(inkAnchor(out), { mode: 'epub-anchor', start: 12, end: 12, aspect: 0.62 });
    assert.equal(inkStrokes(out).length, 1);
    assert.equal(inkPageAspect(out), 1.414, 'no page meta -> default A-series aspect');
  });

  test('limits cap points per stroke and the number of strokes', () => {
    const many = Array.from({ length: INK_LIMITS.maxPointsPerStroke + 50 }, (_, i) => [i / 1e5, 0.5, 0.5]);
    const out = sanitizeInkRects([stroke(many)]);
    assert.equal(out[0].points.length, INK_LIMITS.maxPointsPerStroke);
    const strokes = Array.from({ length: INK_LIMITS.maxStrokes + 10 }, () => stroke([[0.1, 0.1, 0.5]]));
    assert.equal(sanitizeInkRects(strokes).length, INK_LIMITS.maxStrokes);
  });

  test('text/area rects pass through unchanged', () => {
    const rects = [{ mode: 'epub-text', start: 1, end: 5 }];
    assert.equal(sanitizeHighlightRects('text', rects), rects);
    assert.deepEqual(sanitizeHighlightRects('area', 'bad'), []);
  });

  test('thinPoints drops near-duplicate points but keeps both ends', () => {
    const pts = [[0, 0, 0.5], [0.0001, 0, 0.5], [0.0002, 0, 0.5], [0.1, 0, 0.5], [0.1001, 0, 0.5]];
    assert.deepEqual(thinPoints(pts), [[0, 0, 0.5], [0.1, 0, 0.5], [0.1001, 0, 0.5]]);
  });

  test('pressure widens the stroke', () => {
    assert.ok(pressureWidth(4, 1) > pressureWidth(4, 0.5));
    assert.ok(pressureWidth(4, 0.5) > pressureWidth(4, 0));
    assert.equal(pressureWidth(4, Number.NaN), pressureWidth(4, 0.5));
  });

  test('strokeOutlinePath produces a closed path with finite numbers, also for a single dot', () => {
    const d = strokeOutlinePath(stroke([[0.1, 0.1, 0.2], [0.5, 0.4, 0.9], [0.9, 0.2, 0.5]]), 1000, 1414);
    assert.match(d, /^M[\d.-]+ [\d.-]+L.*Z$/);
    assert.doesNotMatch(d, /NaN|Infinity/);
    const dot = strokeOutlinePath(stroke([[0.5, 0.5, 0.5]]), 1000, 1000);
    assert.match(dot, /^M.*a.*Z$/);
  });

  test('eraser hit-testing finds only the strokes near the point', () => {
    const strokes = [stroke([[0.1, 0.1, 0.5], [0.3, 0.1, 0.5]]), stroke([[0.1, 0.8, 0.5], [0.3, 0.8, 0.5]])];
    assert.deepEqual(strokesHitBy(strokes, 0.2, 0.105, 0.012, 1), [0]);
    assert.deepEqual(strokesHitBy(strokes, 0.2, 0.5, 0.012, 1), []);
  });

  test('cropInk re-maps strokes into their bounding box and inkToSvg renders them', () => {
    const { strokes, aspect } = cropInk([stroke([[0.4, 0.4, 0.5], [0.6, 0.5, 0.5]])], 1.5);
    for (const [x, y] of strokes[0].points) {
      assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
    }
    assert.ok(aspect > 0);
    const svg = inkToSvg(strokes, { aspect, width: 480 });
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 480 \d+"><path d="M/);
    assert.match(svg, /fill="#1d4ed8"/);
  });
});

describe('Obsidian export of ink notes', () => {
  test('PDF ink becomes an inline SVG and EPUB ink keeps its context line', () => {
    const { body } = buildObsidianParts({
      book: { id: 'b1', title: 'T', author: '', format: 'pdf', total_pages: 3, current_page: 1, last_opened_at: '' },
      highlights: [
        { page: 2, kind: 'ink', color: 'red', quote_text: '', note: 'my note', rects: [{ mode: 'page', aspect: 1.4 }, stroke([[0.1, 0.1, 0.5], [0.2, 0.2, 0.5]], { color: 'red' })] },
        { page: 3, kind: 'ink', color: 'black', quote_text: 'متن کنار', note: '', rects: [{ mode: 'epub-anchor', start: 3, end: 3, aspect: 0.62 }, stroke([[0.5, 0.5, 0.5]], { color: 'black' })] },
      ],
    });
    assert.match(body, /✍️ \*\*یادداشت دست‌نویس\*\* \(روی صفحه 2، 1 خط\)/);
    assert.match(body, /\*\*یادداشت:\*\* my note/);
    assert.match(body, /<svg width="\d+" style="[^"]+" xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(body, /fill="#dc2626"/);
    assert.match(body, /کنار متن در صفحه 3/);
    assert.match(body, /متن کنار آن: «متن کنار»/);
  });
});

// ---------- HTTP round trips ----------
function rawRequest({ port, method = 'GET', urlPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const json = (res) => JSON.parse(res.body.toString('utf8'));
const send = (port, urlPath, data, method = 'POST') =>
  rawRequest({ port, method, urlPath, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `ketab-test-ink-${label}-`));

describe('ink through the server API and library backup', () => {
  const dirs = [];
  let a;
  let b;
  let book;
  let inkId;
  const s1 = stroke([[0.1, 0.2, 0.4], [0.15, 0.25, 0.6], [0.2, 0.3, 0.9]]);
  const s2 = stroke([[0.5, 0.5, 0.5], [0.6, 0.55, 0.5]], { color: 'red', width: INK_WIDTHS.l });

  before(async () => {
    for (const l of ['a', 'b', 'na', 'nb']) dirs.push(tempDir(l));
    a = await startServer({ host: '127.0.0.1', port: 0, dataDir: dirs[0], obsidianDir: dirs[2] });
    b = await startServer({ host: '127.0.0.1', port: 0, dataDir: dirs[1], obsidianDir: dirs[3] });
    book = json(await rawRequest({ port: a.port, method: 'POST', urlPath: '/api/books/seed' })).book;
  });

  after(async () => {
    for (const ctx of [a, b]) {
      await new Promise((resolve) => ctx.server.close(resolve));
      ctx.store.close();
    }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  test('POST accepts kind "ink" and stores sanitized strokes', async () => {
    const res = await send(a.port, `/api/books/${book.id}/highlights`, {
      page: 2, kind: 'ink', color: 'blue', rects: [{ mode: 'page', aspect: 1.29 }, s1],
    });
    assert.equal(res.status, 201, String(res.body));
    const { highlight } = json(res);
    inkId = highlight.id;
    assert.equal(highlight.kind, 'ink');
    assert.deepEqual(highlight.rects, [{ mode: 'page', aspect: 1.29 }, s1]);
  });

  test('POST rejects ink without a usable stroke', async () => {
    const res = await send(a.port, `/api/books/${book.id}/highlights`, { page: 2, kind: 'ink', rects: [{ points: [] }] });
    assert.equal(res.status, 400);
  });

  test('unknown kinds are stored as text (whitelist)', async () => {
    const res = await send(a.port, `/api/books/${book.id}/highlights`, { page: 1, kind: 'evil', rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] });
    assert.equal(json(res).highlight.kind, 'text');
  });

  test('PATCH rects appends strokes to an ink note; text highlights refuse rects', async () => {
    const res = await send(a.port, `/api/highlights/${inkId}`, { rects: [{ mode: 'page', aspect: 1.29 }, s1, s2], note: 'n1' }, 'PATCH');
    assert.equal(res.status, 200, String(res.body));
    assert.equal(json(res).highlight.rects.length, 3);
    assert.equal(json(res).highlight.note, 'n1');

    const text = json(await send(a.port, `/api/books/${book.id}/highlights`, { page: 1, kind: 'text', quote_text: 'q', rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }] })).highlight;
    const bad = await send(a.port, `/api/highlights/${text.id}`, { rects: [s1] }, 'PATCH');
    assert.equal(bad.status, 400);
    const empty = await send(a.port, `/api/highlights/${inkId}`, { rects: [] }, 'PATCH');
    assert.equal(empty.status, 400);
  });

  test('ink survives export -> import into another library, strokes intact', async () => {
    const backup = json(await rawRequest({ port: a.port, urlPath: '/api/library/export' }));
    const inkRow = backup.highlights.find((h) => h.kind === 'ink');
    assert.ok(inkRow);
    assert.deepEqual(inkRow.rects, [{ mode: 'page', aspect: 1.29 }, s1, s2]);

    // A corrupted ink row in the backup is skipped, not imported as garbage.
    backup.highlights.push({ ...inkRow, id: '00000000-0000-4000-8000-0000000000ff', rects: [{ points: 'x' }] });

    const target = json(await rawRequest({ port: b.port, method: 'POST', urlPath: '/api/books/seed' })).book;
    const res = await send(b.port, '/api/library/import', backup);
    assert.equal(res.status, 200, String(res.body));
    const full = json(await rawRequest({ port: b.port, urlPath: `/api/books/${target.id}` }));
    const ink = full.highlights.filter((h) => h.kind === 'ink');
    assert.equal(ink.length, 1);
    assert.deepEqual(ink[0].rects, [{ mode: 'page', aspect: 1.29 }, s1, s2]);
  });

  test('Obsidian export of a book with ink writes the SVG', async () => {
    const res = await rawRequest({ port: a.port, method: 'POST', urlPath: `/api/books/${book.id}/export-obsidian` });
    assert.equal(res.status, 200);
    assert.match(json(res).markdown, /یادداشت دست‌نویس[\s\S]*<svg /);
  });
});

describe('JSON fallback store keeps ink kind and rects', () => {
  test('insert + rects update + non-ink rects ignored', () => {
    const dir = tempDir('json');
    try {
      const store = createJsonStore(dir, path.join(dir, 'books'));
      const hl = store.insertHighlight({ book_id: 'b', page: 1, kind: 'ink', rects: [stroke([[0.1, 0.1, 0.5]])] });
      assert.equal(hl.kind, 'ink');
      const updated = store.updateHighlight(hl.id, { rects: [stroke([[0.2, 0.2, 0.5]]), stroke([[0.3, 0.3, 0.5]])] });
      assert.equal(updated.rects.length, 2);
      const text = store.insertHighlight({ book_id: 'b', page: 1, kind: 'text', rects: [{ x: 0, y: 0, w: 1, h: 1 }] });
      const same = store.updateHighlight(text.id, { rects: [stroke([[0.2, 0.2, 0.5]])] });
      assert.deepEqual(same.rects, [{ x: 0, y: 0, w: 1, h: 1 }]);
      assert.equal(store.getHighlight(hl.id).rects.length, 2);
      store.close?.();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
