import * as pdfjsLib from '/vendor/pdfjs/legacy/build/pdf.mjs';
import { api } from './api.js';
import { normalizePersianText, reconstructPageText } from './bilingual-text.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.mjs';

export class PdfEngine {
  constructor({ viewportEl, containerEl, onPageChange, onAnnotationsRender }) {
    this.viewportEl = viewportEl;
    this.containerEl = containerEl;
    this.onPageChange = onPageChange;
    this.onAnnotationsRender = onAnnotationsRender;

    this.loadingTask = null;
    this.pdfDoc = null;
    this.numPages = 0;
    this.currentPage = 1;
    this.scale = 1.25;
    this.zoomMode = 'fit-width'; // 'fit-width' | 'fit-page' | 'custom'
    this.viewMode = 'scroll';    // 'scroll' | 'single' | 'spread'
    this.readingDir = 'rtl';     // 'rtl' | 'ltr'

    this.baseWidth = 595;
    this.baseHeight = 842;
    this.pageShells = new Map();
    this.renderedPages = new Set();
    this.renderingTasks = new Map();
    this.activeRenderHandles = new Map();
    this.observer = null;
    this.searchAbort = null;
  }

  async loadBook(bookId) {
    this.destroy();
    const source = await api.getBookPdfSource(bookId);
    const loadingTask = pdfjsLib.getDocument({
      ...source,
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      wasmUrl: '/vendor/pdfjs/wasm/',
      iccUrl: '/vendor/pdfjs/iccs/',
    });
    this.loadingTask = loadingTask;
    this.pdfDoc = await loadingTask.promise;
    this.loadingTask = null;
    this.numPages = this.pdfDoc.numPages;

    const firstPage = await this.pdfDoc.getPage(1);
    const vp = firstPage.getViewport({ scale: 1 });
    this.baseWidth = vp.width;
    this.baseHeight = vp.height;

    return {
      numPages: this.numPages,
      firstPage,
    };
  }

  async inspectBookIntelligence(firstPage) {
    if (!this.pdfDoc) return { detectedDir: 'ltr', pdfTitle: '', pdfAuthor: '' };
    const meta = await this.pdfDoc.getMetadata().catch(() => null);
    const info = meta?.info || {};
    const pdfTitle = typeof info.Title === 'string' ? normalizePersianText(info.Title) : '';
    const pdfAuthor = typeof info.Author === 'string' ? normalizePersianText(info.Author) : '';

    let sampleText = '';
    let detectedDir = 'ltr';

    try {
      const tc1 = await firstPage.getTextContent();
      const rec1 = reconstructPageText(tc1);
      sampleText = rec1.fullText;
      detectedDir = rec1.dominantDir;

      // If page 1 is an image cover with very little text, inspect page 2 or 3
      if (sampleText.length < 30 && this.numPages >= 2) {
        const p2 = await this.pdfDoc.getPage(Math.min(3, this.numPages));
        const tc2 = await p2.getTextContent();
        const rec2 = reconstructPageText(tc2);
        if (rec2.fullText.length > sampleText.length) {
          detectedDir = rec2.dominantDir;
        }
      }
    } catch {}

    return { detectedDir, pdfTitle, pdfAuthor };
  }

  async extractCoverDataUrl(firstPage) {
    const vp1 = firstPage.getViewport({ scale: 1 });
    const targetWidth = 300;
    const scale = targetWidth / vp1.width;
    const vp = firstPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.dir = 'ltr';
    canvas.style.direction = 'ltr';
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.direction = 'ltr';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await firstPage.render({ canvasContext: ctx, viewport: vp }).promise;
    return canvas.toDataURL('image/webp', 0.82);
  }

  async extractOutline() {
    if (!this.pdfDoc) return [];
    const raw = await this.pdfDoc.getOutline().catch(() => null);
    if (!raw || !Array.isArray(raw)) return [];

    const resolveDestPage = async (dest) => {
      try {
        let resolved = dest;
        if (typeof dest === 'string') {
          resolved = await this.pdfDoc.getDestination(dest);
        }
        if (Array.isArray(resolved) && resolved[0]) {
          const idx = await this.pdfDoc.getPageIndex(resolved[0]);
          return idx + 1;
        }
      } catch {
        return null;
      }
      return null;
    };

    const walk = async (items, level = 0) => {
      const out = [];
      for (const item of items) {
        const page = await resolveDestPage(item.dest);
        out.push({
          title: normalizePersianText(item.title || '') || 'بدون عنوان',
          page: page || 1,
          level,
          isNative: true,
        });
        if (Array.isArray(item.items) && item.items.length > 0) {
          const children = await walk(item.items, level + 1);
          out.push(...children);
        }
      }
      return out;
    };

    return walk(raw, 0);
  }

  computeScale() {
    const isNarrow = window.innerWidth < 820;
    const rawW = this.viewportEl.clientWidth > 100
      ? this.viewportEl.clientWidth
      : Math.max(300, window.innerWidth - (isNarrow ? 16 : 320));
    const rawH = this.viewportEl.clientHeight > 100
      ? this.viewportEl.clientHeight
      : Math.max(420, window.innerHeight - 60);

    const availW = Math.max(260, rawW - (rawW < 600 ? 16 : 56));
    const availH = Math.max(300, rawH - 48);

    if (this.zoomMode === 'fit-width') {
      if (this.viewMode === 'spread') {
        const targetW = availW / 2.08;
        return Math.max(0.45, Math.min(2.6, targetW / this.baseWidth));
      }
      const comfortableW = Math.min(availW, 960);
      return Math.max(0.45, Math.min(2.6, comfortableW / this.baseWidth));
    }
    if (this.zoomMode === 'fit-page') {
      return Math.max(0.45, Math.min(2.6, Math.min(availW / this.baseWidth, availH / this.baseHeight)));
    }
    return this.scale;
  }

  buildLayout() {
    if (!this.pdfDoc) return;
    this.clearRenderedState();
    this.scale = this.computeScale();

    this.containerEl.classList.toggle('view-spread', this.viewMode === 'spread');
    this.containerEl.dataset.spreadDir = this.readingDir;
    this.containerEl.removeAttribute('dir');
    this.containerEl.innerHTML = '';
    this.pageShells.clear();

    const w = Math.round(this.baseWidth * this.scale);
    const h = Math.round(this.baseHeight * this.scale);

    const visibleSet = this.getVisiblePageSet();

    for (let p = 1; p <= this.numPages; p++) {
      if (visibleSet && !visibleSet.has(p)) continue;

      const shell = document.createElement('div');
      shell.className = 'pdf-page-shell';
      shell.dir = 'ltr'; // CRITICAL: isolate PDF canvas/textLayer from RTL document cascade
      shell.dataset.page = String(p);
      shell.style.width = `${w}px`;
      shell.style.height = `${h}px`;
      shell.style.setProperty('--total-scale-factor', String(this.scale));

      const badge = document.createElement('span');
      badge.className = 'page-badge';
      badge.textContent = String(p);
      shell.appendChild(badge);

      this.containerEl.appendChild(shell);
      this.pageShells.set(p, shell);
    }

    if (this.viewMode === 'scroll') {
      this.setupObserver();
    } else {
      for (const p of this.pageShells.keys()) {
        this.renderPage(p);
      }
    }
  }

  getVisiblePageSet() {
    if (this.viewMode === 'single') {
      return new Set([this.currentPage]);
    }
    if (this.viewMode === 'spread') {
      if (this.currentPage === 1) return new Set([1]);
      const start = this.currentPage % 2 === 0 ? this.currentPage : this.currentPage - 1;
      const set = new Set([start]);
      if (start + 1 <= this.numPages) set.add(start + 1);
      return set;
    }
    return null;
  }

  setupObserver() {
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const p = Number(entry.target.dataset.page);
          if (entry.isIntersecting) {
            this.renderPage(p);
          }
        }
        this.updateCurrentPageFromScroll();
        this.pruneDistantPages();
      },
      {
        root: this.viewportEl,
        rootMargin: '900px 0px',
        threshold: [0.05, 0.35],
      }
    );

    for (const shell of this.pageShells.values()) {
      this.observer.observe(shell);
    }
  }

  updateCurrentPageFromScroll() {
    if (this.viewMode !== 'scroll' || this.pageShells.size === 0) return;
    const vpRect = this.viewportEl.getBoundingClientRect();
    const centerY = vpRect.top + vpRect.height * 0.35;

    let bestPage = this.currentPage;
    let bestDist = Infinity;
    for (const [p, shell] of this.pageShells.entries()) {
      const r = shell.getBoundingClientRect();
      const mid = (r.top + r.bottom) / 2;
      const dist = Math.abs(mid - centerY);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = p;
      }
    }
    if (bestPage !== this.currentPage) {
      this.currentPage = bestPage;
      this.onPageChange?.(bestPage);
    }
  }

  pruneDistantPages() {
    if (this.viewMode !== 'scroll') return;
    for (const p of Array.from(this.renderedPages)) {
      if (Math.abs(p - this.currentPage) > 10) {
        const shell = this.pageShells.get(p);
        if (shell) {
          shell.querySelector('canvas')?.remove();
          shell.querySelector('.textLayer')?.remove();
        }
        this.renderedPages.delete(p);
      }
    }
  }

  async renderPage(pageNum) {
    if (!this.pdfDoc || this.renderedPages.has(pageNum) || this.renderingTasks.has(pageNum)) {
      return;
    }
    const shell = this.pageShells.get(pageNum);
    if (!shell) return;

    const promise = (async () => {
      const handle = { renderTask: null, textLayer: null };
      this.activeRenderHandles.set(pageNum, handle);
      try {
        const page = await this.pdfDoc.getPage(pageNum);
        if (!this.pdfDoc || !this.pageShells.has(pageNum)) return;

        const viewport = page.getViewport({ scale: this.scale });
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        shell.style.width = `${Math.round(viewport.width)}px`;
        shell.style.height = `${Math.round(viewport.height)}px`;
        shell.style.setProperty('--total-scale-factor', String(this.scale));

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.dir = 'ltr';
        canvas.style.direction = 'ltr';
        canvas.width = Math.round(viewport.width * dpr);
        canvas.height = Math.round(viewport.height * dpr);
        canvas.style.width = `${Math.round(viewport.width)}px`;
        canvas.style.height = `${Math.round(viewport.height)}px`;

        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.direction = 'ltr';
        ctx.textAlign = 'left';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, viewport.width, viewport.height);

        shell.prepend(canvas);
        handle.renderTask = page.render({ canvasContext: ctx, viewport });
        await handle.renderTask.promise;

        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.dir = 'ltr';
        shell.appendChild(textLayerDiv);

        const textContent = await page.getTextContent();
        if (!this.pdfDoc || !this.pageShells.has(pageNum)) return;

        handle.textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await handle.textLayer.render();

        this.renderedPages.add(pageNum);
        this.onAnnotationsRender?.(pageNum, shell);
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException' && err?.name !== 'AbortException') {
          console.error(`Error rendering page ${pageNum}:`, err);
        }
      } finally {
        this.activeRenderHandles.delete(pageNum);
        this.renderingTasks.delete(pageNum);
      }
    })();

    this.renderingTasks.set(pageNum, promise);
    return promise;
  }

  goToPage(pageNum, behavior = 'auto') {
    const target = Math.max(1, Math.min(this.numPages || 1, Number(pageNum) || 1));
    this.currentPage = target;
    this.onPageChange?.(target);

    if (this.viewMode === 'scroll') {
      const shell = this.pageShells.get(target);
      if (shell) {
        const top = Math.max(0, shell.offsetTop - 16);
        this.viewportEl.scrollTo({ top, left: 0, behavior });
      }
    } else {
      this.buildLayout();
      this.viewportEl.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }

  stepPage(delta) {
    const step = this.viewMode === 'spread' ? delta * 2 : delta;
    this.goToPage(this.currentPage + step, 'auto');
  }

  async searchBook(query, onMatch, onDone) {
    if (!this.pdfDoc || !query.trim()) return;
    if (this.searchAbort) this.searchAbort.abort = true;
    const token = { abort: false };
    this.searchAbort = token;

    const q = normalizePersianText(query.trim()).toLowerCase();
    let totalMatches = 0;

    for (let p = 1; p <= this.numPages; p++) {
      if (token.abort) return;
      const page = await this.pdfDoc.getPage(p);
      const tc = await page.getTextContent();
      const { fullText } = reconstructPageText(tc);
      const lower = fullText.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        totalMatches++;
        const start = Math.max(0, idx - 36);
        const end = Math.min(fullText.length, idx + q.length + 54);
        const snippet = (start > 0 ? '…' : '') + fullText.slice(start, end) + (end < fullText.length ? '…' : '');
        onMatch({ page: p, snippet });
        idx = lower.indexOf(q, idx + q.length);
        if (totalMatches >= 120) break;
      }
      if (totalMatches >= 120) break;
    }

    if (!token.abort) {
      onDone(totalMatches);
    }
  }

  clearRenderedState() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    for (const handle of this.activeRenderHandles.values()) {
      try { handle.renderTask?.cancel(); } catch {}
      try { handle.textLayer?.cancel(); } catch {}
    }
    this.activeRenderHandles.clear();
    this.renderedPages.clear();
    this.renderingTasks.clear();
  }

  destroy() {
    this.clearRenderedState();
    if (this.searchAbort) this.searchAbort.abort = true;
    if (this.loadingTask) {
      try { this.loadingTask.destroy(); } catch {}
      this.loadingTask = null;
    }
    this.containerEl.innerHTML = '';
    this.pageShells.clear();
    if (this.pdfDoc) {
      const doc = this.pdfDoc;
      this.pdfDoc = null;
      Promise.resolve(doc.loadingTask?.destroy?.() ?? doc.cleanup?.()).catch(() => {});
    }
  }
}
