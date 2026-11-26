// Browser check for S Pen support with synthetic pen input over the Chrome DevTools Protocol.
//   node scripts/pen-check.mjs [outDir] [--mode=server|client|both]
// Server mode: the real API server (SQLite). Client mode: public/ served statically with /api/* -> 404,
// so the SPA falls back to IndexedDB exactly like the Android APK.
// Pen events: Input.dispatchMouseEvent with pointerType "pen", force (pressure), tiltX/tiltY;
// the S Pen side button is the right button (buttons & 2). Screenshots go to outDir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'ketabkhan-pen-check'));
const modeArg = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=both').slice(7);
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
fs.mkdirSync(outDir, { recursive: true });

// ---------- a 2-page test PDF: page 1 has real text, page 2 is "scanned" (shapes only, no text layer) ----------
function buildTestPdf() {
  const lines = [
    'Ketabkhan Studio S Pen test page.',
    'Drag the pen over this sentence to highlight it.',
    'The quick brown fox jumps over the lazy dog.',
    'Handwritten ink goes straight onto the page.',
  ];
  const text = lines.map((l, i) => `BT /F1 20 Tf 60 ${700 - i * 48} Td (${l}) Tj ET`).join('\n');
  const scan = '0.85 g 60 520 480 26 re f 60 470 420 26 re f 60 420 450 26 re f 0.6 g 60 200 300 160 re f';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    `<< /Length ${scan.length} >>\nstream\n${scan}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- static server for client (IndexedDB) mode ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
function startStaticServer() {
  const map = [
    ['/vendor/pdfjs/', path.join(ROOT, 'node_modules', 'pdfjs-dist')],
    ['/vendor/vazirmatn/', path.join(ROOT, 'node_modules', 'vazirmatn')],
    ['/', path.join(ROOT, 'public')],
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(404).end();
      return;
    }
    for (const [prefix, dir] of map) {
      if (!url.pathname.startsWith(prefix)) continue;
      let file = path.join(dir, decodeURIComponent(url.pathname.slice(prefix.length)));
      if (!file.startsWith(dir)) break;
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        if (prefix !== '/') break;
        file = path.join(dir, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- CDP ----------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} ${m.error.data || ''}`));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const i = ++this.id;
      this.pending.set(i, { resolve, reject });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, timeout = 15000, label = expression) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await this.eval(expression)) return;
      } catch {
        // page not ready yet
      }
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label}`);
  }
}

async function launchChrome() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ketab-pen-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {
      // not up yet
    }
  }
  if (!target) throw new Error('Chrome did not start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new Cdp(ws);
  const close = async () => {
    try { ws.close(); } catch {}
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(500); // Chrome child processes still release the profile
      }
    }
  };
  return { cdp, close };
}

// ---------- pen gestures ----------
function makePen(cdp) {
  const ev = (type, x, y, o = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y,
    button: o.button || 'none',
    buttons: o.buttons || 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: 'pen',
    force: o.force ?? 0,
    tiltX: o.tiltX ?? 12,
    tiltY: o.tiltY ?? -8,
  });
  return {
    async hover(x, y) {
      await ev('mouseMoved', x, y);
      await sleep(60);
    },
    async stroke(points, { side = false } = {}) {
      const button = side ? 'right' : 'left';
      const buttons = side ? 2 : 1;
      const [x0, y0] = points[0];
      await ev('mouseMoved', x0, y0);
      await ev('mousePressed', x0, y0, { button, buttons, force: 0.3 });
      for (let i = 1; i < points.length; i++) {
        const [x, y] = points[i];
        const force = 0.25 + 0.7 * Math.sin((Math.PI * i) / points.length); // pressure swells mid-stroke
        await ev('mouseMoved', x, y, { button, buttons, force });
      }
      const [xl, yl] = points[points.length - 1];
      await ev('mouseReleased', xl, yl, { button, buttons: 0, force: 0 });
      await sleep(120);
    },
  };
}

const line = (x1, y1, x2, y2, n = 18) => Array.from({ length: n + 1 }, (_, i) => [x1 + ((x2 - x1) * i) / n, y1 + ((y2 - y1) * i) / n]);
const wave = (x1, y, w, amp, n = 30) => Array.from({ length: n + 1 }, (_, i) => [x1 + (w * i) / n, y + amp * Math.sin((i / n) * Math.PI * 3)]);

async function shot(cdp, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

const results = [];
function check(mode, name, ok, detail = '') {
  results.push({ mode, name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${mode}] ${name}${detail ? ` - ${detail}` : ''}`);
}

const getHighlights = (cdp, bookId) => cdp.eval(`(async () => {
  const { api } = await import('/js/api.js');
  const data = await api.getBook(${JSON.stringify(bookId)});
  return data.highlights.map((h) => ({ id: h.id, kind: h.kind, page: h.page, color: h.color, quote: h.quote_text, rects: h.rects }));
})()`);

async function openBook(cdp, baseUrl, bookId) {
  await cdp.send('Page.navigate', { url: baseUrl });
  await cdp.waitFor(`!!document.querySelector('[data-open-book="${bookId}"]')`, 20000, 'library card');
  await cdp.eval(`document.querySelector('[data-open-book="${bookId}"]').click(), true`);
  await cdp.waitFor(`!document.getElementById('reader-view').hidden`, 10000, 'reader view');
}

async function runMode(mode, baseUrl, setupBooks) {
  const { cdp, close } = await launchChrome();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Galaxy S Ultra-sized phone viewport.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: baseUrl });
    await cdp.waitFor(`document.readyState === 'complete' && !!document.getElementById('library-view')`, 20000, 'app shell');
    await sleep(800);
    const { pdfId, epubId } = await setupBooks(cdp);
    const pen = makePen(cdp);
    const clientOnly = await cdp.eval(`(async () => (await import('/js/api.js')).api.isClientOnly())()`);
    check(mode, 'backend', mode === 'client' ? clientOnly === true : clientOnly === false, `isClientOnly=${clientOnly}`);

    // ===== PDF =====
    await openBook(cdp, baseUrl, pdfId);
    await cdp.waitFor(`[...document.querySelectorAll('.pdf-page-shell[data-page="1"] .textLayer span')].some((s) => s.textContent.includes('quick brown'))`, 20000, 'PDF text layer');
    await sleep(400);
    const span = await cdp.eval(`(() => {
      const s = [...document.querySelectorAll('.pdf-page-shell[data-page="1"] .textLayer span')].find((x) => x.textContent.includes('quick brown'));
      const r = s.getBoundingClientRect();
      const p = s.closest('.pdf-page-shell').getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, pl: p.left, pr: p.right, pt: p.top, pb: p.bottom };
    })()`);
    const midY = (span.t + span.b) / 2;

    await pen.hover(span.l + 10, midY - 40);
    const near = await cdp.eval(`({ near: document.getElementById('pdf-viewport').classList.contains('pen-near'), toolbar: !document.getElementById('pen-toolbar').hidden, ta: getComputedStyle(document.querySelector('.pdf-page-shell')).touchAction })`);
    check(mode, 'pen hover shows the pen toolbar', near.toolbar);
    check(mode, 'pen hover sets touch-action none on the page', near.near && near.ta === 'none', `touch-action=${near.ta}`);

    // Highlight tool: drag across "The quick brown fox..."
    await cdp.eval(`document.querySelector('[data-pen-tool="highlight"]').click(), document.querySelector('[data-pen-hl-color="sky"]').click(), true`);
    let before = (await getHighlights(cdp, pdfId)).length;
    await pen.stroke(line(span.l + 2, midY, span.r - 4, midY + 1, 20));
    await sleep(700);
    let hls = await getHighlights(cdp, pdfId);
    const textHl = hls.find((h) => h.kind === 'text' && h.page === 1);
    check(mode, 'PDF pen drag creates a text highlight', hls.length === before + 1 && textHl && /quick brown/.test(textHl.quote) && textHl.color === 'sky', textHl ? `quote="${textHl.quote}"` : 'none');

    // Finger drag over text while the pen is near: must not annotate (palm rejection).
    before = hls.length;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: span.l + 4, y: midY + 48 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: span.l + 4 + i * 25, y: midY + 48 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(700);
    hls = await getHighlights(cdp, pdfId);
    check(mode, 'finger drag does not create annotations', hls.length === before);

    // Ink tool: two strokes on page 1 -> one ink note with 2 pressure strokes.
    await cdp.eval(`document.querySelector('[data-pen-tool="ink"]').click(), document.querySelector('[data-pen-ink-color="blue"]').click(), document.querySelector('[data-pen-size="m"]').click(), true`);
    const inkY = span.b + 150;
    await pen.stroke(wave(span.pl + 40, inkY, 280, 18, 36));
    await pen.stroke(line(span.pl + 40, inkY + 40, span.pl + 300, inkY + 30, 20));
    await cdp.eval(`document.querySelector('[data-pen-ink-color="red"]').click(), document.querySelector('[data-pen-size="l"]').click(), true`);
    await pen.stroke([...line(span.pl + 320, inkY - 30, span.pl + 360, inkY + 40, 10), ...line(span.pl + 360, inkY + 40, span.pl + 390, inkY - 40, 10)]);
    await sleep(1400);
    hls = await getHighlights(cdp, pdfId);
    let ink = hls.filter((h) => h.kind === 'ink' && h.page === 1);
    const strokes = ink[0]?.rects.filter((r) => r.points) || [];
    const pressures = strokes[0]?.points.map((p) => p[2]) || [];
    check(mode, 'PDF ink strokes saved as one kind "ink" note', ink.length === 1 && strokes.length === 3, `notes=${ink.length} strokes=${strokes.length}`);
    check(mode, 'ink keeps pressure, colours and widths', Math.max(...pressures) - Math.min(...pressures) > 0.3 && strokes[0].color === 'blue' && strokes[2]?.color === 'red' && strokes[2].width > strokes[0].width, `pressure ${Math.min(...pressures)}..${Math.max(...pressures)}`);
    check(mode, 'ink page meta stores the page aspect', ink[0]?.rects[0]?.mode === 'page' && ink[0].rects[0].aspect > 1);
    const drawn = await cdp.eval(`document.querySelectorAll('.pdf-page-shell[data-page="1"] .ink-svg path').length`);
    check(mode, 'ink is drawn on the PDF overlay', drawn === 3, `paths=${drawn}`);
    await shot(cdp, `${mode}-pdf-ink-toolbar`);

    // Side button held = stroke eraser: rub across the straight line.
    await pen.stroke(line(span.pl + 170, inkY + 15, span.pl + 170, inkY + 60, 12), { side: true });
    await sleep(1200);
    hls = await getHighlights(cdp, pdfId);
    ink = hls.filter((h) => h.kind === 'ink' && h.page === 1);
    const left = ink[0]?.rects.filter((r) => r.points).length;
    check(mode, 'side button erases a stroke', left === 2, `strokes left=${left}`);

    // Scanned page 2 (no text layer text): pen highlight falls back to an area highlight.
    await cdp.eval(`document.querySelector('[data-pen-tool="highlight"]').click(), true`);
    await cdp.eval(`(() => { const s = document.querySelector('.pdf-page-shell[data-page="2"]'); document.getElementById('pdf-viewport').scrollTo({ top: s.offsetTop + 120 }); return true; })()`);
    await cdp.waitFor(`!!document.querySelector('.pdf-page-shell[data-page="2"] canvas')`, 15000, 'page 2 render');
    await sleep(800);
    const p2 = await cdp.eval(`(() => { const r = document.querySelector('.pdf-page-shell[data-page="2"]').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    const scanY = p2.t + p2.h * (1 - 533 / 792);
    await pen.hover(p2.l + p2.w * 0.12, scanY);
    await pen.stroke(line(p2.l + p2.w * 0.1, scanY, p2.l + p2.w * 0.85, scanY + 2, 16));
    await sleep(700);
    hls = await getHighlights(cdp, pdfId);
    const area = hls.find((h) => h.kind === 'area' && h.page === 2);
    check(mode, 'scanned page: pen drag makes an area highlight', Boolean(area), area ? JSON.stringify(area.rects[0]) : 'none');
    await shot(cdp, `${mode}-pdf-scanned-area`);

    // ===== EPUB =====
    await openBook(cdp, baseUrl, epubId);
    await cdp.waitFor(`!!document.querySelector('.epub-chapter-body p:not(.epub-loading-hint)')`, 20000, 'EPUB chapter');
    await sleep(600);
    const para = await cdp.eval(`(() => {
      const p = [...document.querySelectorAll('.epub-chapter-shell[data-page="1"] .epub-chapter-body p')].find((x) => x.textContent.trim().length > 40) || document.querySelector('.epub-chapter-body p');
      const range = document.createRange(); range.selectNodeContents(p);
      const first = range.getClientRects()[0];
      const box = p.getBoundingClientRect();
      return { l: box.left + 4, r: box.right - 4, t: first.top, b: first.bottom, text: p.textContent.slice(0, 40) };
    })()`);
    const pY = (para.t + para.b) / 2;
    before = (await getHighlights(cdp, epubId)).length;
    await pen.hover(para.r - 6, pY - 30);
    await pen.stroke(line(para.r - 6, pY, para.l + (para.r - para.l) * 0.35, pY, 18));
    await sleep(800);
    hls = await getHighlights(cdp, epubId);
    const eh = hls.find((h) => h.kind === 'text');
    check(mode, 'EPUB pen drag creates a reflowable text highlight', hls.length === before + 1 && eh?.rects[0]?.mode === 'epub-text', eh ? `quote="${eh.quote}"` : 'none');
    const marks = await cdp.eval(`document.querySelectorAll('mark.epub-hl').length`);
    check(mode, 'EPUB highlight is rendered as <mark>', marks > 0, `marks=${marks}`);

    // Ink tool on EPUB: pen tap on text opens the handwritten note card.
    await cdp.eval(`document.querySelector('[data-pen-tool="ink"]').click(), true`);
    await pen.stroke([[para.l + 30, pY + 40], [para.l + 31, pY + 40]]);
    await cdp.waitFor(`document.getElementById('ink-card-dialog').open`, 5000, 'ink card dialog');
    await sleep(300);
    const pad = await cdp.eval(`(() => { const r = document.getElementById('ink-card-pad').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
    await pen.stroke(wave(pad.l + 20, pad.t + pad.h * 0.35, pad.w * 0.8, 14, 34));
    await pen.stroke(line(pad.l + 30, pad.t + pad.h * 0.7, pad.l + pad.w * 0.7, pad.t + pad.h * 0.65, 16));
    await sleep(200);
    await shot(cdp, `${mode}-epub-ink-card`);
    await cdp.eval(`document.querySelector('#ink-card-form button[type="submit"]').click(), true`);
    await sleep(1000);
    hls = await getHighlights(cdp, epubId);
    const card = hls.find((h) => h.kind === 'ink');
    check(mode, 'EPUB ink note saved with a text anchor', card && card.rects[0].mode === 'epub-anchor' && card.rects.filter((r) => r.points).length === 2, card ? `anchor=${JSON.stringify(card.rects[0])}` : 'none');
    const marker = await cdp.eval(`document.querySelectorAll('.epub-chapter-shell .ink-marker').length`);
    check(mode, 'EPUB ink note shows a margin marker', marker === 1, `markers=${marker}`);
    await shot(cdp, `${mode}-epub-ink-marker`);

    // Sidebar lists the ink note with a thumbnail.
    await cdp.eval(`document.getElementById('btn-toggle-sidebar')?.click(), true`);
    await sleep(300);
    await cdp.eval(`[...document.querySelectorAll('[role="tab"]')].find((t) => /هایلایت/.test(t.textContent))?.click(), true`);
    await sleep(400);
    const thumb = await cdp.eval(`document.querySelectorAll('#highlights-list .ink-thumb').length`);
    check(mode, 'sidebar shows the ink note thumbnail', thumb >= 1, `thumbs=${thumb}`);
    await shot(cdp, `${mode}-epub-sidebar`);
  } finally {
    await close();
  }
}

async function main() {
  const pdf = buildTestPdf();
  const modes = modeArg === 'both' ? ['server', 'client'] : [modeArg];

  if (modes.includes('server')) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ketab-pen-data-'));
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ketab-pen-notes-'));
    const ctx = await startServer({ host: '127.0.0.1', port: 0, dataDir, obsidianDir: notesDir });
    const base = `http://127.0.0.1:${ctx.port}/`;
    try {
      await runMode('server', base, async () => {
        const up = await fetch(`${base}api/books`, { method: 'POST', headers: { 'x-book-filename': 'pen-test.pdf', 'Content-Type': 'application/pdf' }, body: pdf });
        const pdfId = (await up.json()).book.id;
        const epubId = (await (await fetch(`${base}api/books/seed`, { method: 'POST' })).json()).book.id;
        return { pdfId, epubId };
      });
      const md = await (await fetch(`${base}api/books/${(await (await fetch(`${base}api/books`)).json()).books.find((b) => b.format === 'pdf').id}/export-obsidian`, { method: 'POST' })).json();
      check('server', 'Obsidian export contains the ink SVG', /یادداشت دست‌نویس[\s\S]*<svg /.test(md.markdown || ''));
    } finally {
      await new Promise((r) => ctx.server.close(r));
      ctx.store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(notesDir, { recursive: true, force: true });
    }
  }

  if (modes.includes('client')) {
    const server = await startStaticServer();
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
      await runMode('client', base, async (cdp) => {
        const b64 = pdf.toString('base64');
        const ids = await cdp.eval(`(async () => {
          const { api } = await import('/js/api.js');
          const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
          const { book: p } = await api.uploadBookFile(new File([bytes], 'pen-test.pdf', { type: 'application/pdf' }));
          const { book: e } = await api.seedSampleBook();
          return { pdfId: p.id, epubId: e.id };
        })()`);
        return ids;
      });
    } finally {
      server.close();
    }
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${outDir}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('ERR', err.stack || err.message);
  process.exitCode = 1;
});
