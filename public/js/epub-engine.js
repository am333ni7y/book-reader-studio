import { api } from './api.js';
import { normalizePersianText } from './bilingual-text.js';

const SAFE_EPUB_ELEMENTS = [
  'div', 'span', 'p', 'br', 'hr', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'abbr', 'cite', 'q', 'kbd', 'var',
  'figure', 'figcaption', 'img', 'picture', 'source',
  'section', 'article', 'header', 'footer', 'aside', 'main', 'nav',
  'svg', 'g', 'path', 'rect', 'circle', 'line', 'polyline', 'polygon', 'image',
];

const SAFE_EPUB_ATTRIBUTES = [
  'class', 'id', 'dir', 'lang', 'title', 'alt', 'src', 'poster',
  'width', 'height', 'colspan', 'rowspan', 'scope',
  'href', 'target', 'rel', 'data-epub-page', 'data-epub-anchor',
  'viewbox', 'd', 'fill', 'stroke', 'stroke-width', 'x', 'y', 'cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2', 'points',
];

const SAFE_EPUB_ELEMENT_SET = new Set(SAFE_EPUB_ELEMENTS);
const SAFE_EPUB_ATTR_SET = new Set(SAFE_EPUB_ATTRIBUTES);

function sanitizeNodeTreeFallback(srcNode, targetDoc) {
  if (srcNode.nodeType === Node.TEXT_NODE) {
    return targetDoc.createTextNode(srcNode.nodeValue || '');
  }
  if (srcNode.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const tag = srcNode.tagName.toLowerCase();
  if (!SAFE_EPUB_ELEMENT_SET.has(tag)) {
    return null;
  }

  const isSvg = tag === 'svg' || srcNode.namespaceURI === 'http://www.w3.org/2000/svg';
  const cleanEl = isSvg
    ? targetDoc.createElementNS('http://www.w3.org/2000/svg', tag)
    : targetDoc.createElement(tag);

  for (const attr of Array.from(srcNode.attributes)) {
    const name = attr.name.toLowerCase();
    if (!SAFE_EPUB_ATTR_SET.has(name)) continue;
    const val = attr.value || '';
    if ((name === 'href' || name === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(val)) {
      continue;
    }
    cleanEl.setAttribute(name, val);
  }

  for (const child of Array.from(srcNode.childNodes)) {
    const cleanChild = sanitizeNodeTreeFallback(child, targetDoc);
    if (cleanChild) cleanEl.appendChild(cleanChild);
  }

  return cleanEl;
}

export function setSafeChapterHTML(targetEl, rawHtml) {
  if ('setHTML' in Element.prototype) {
    targetEl.setHTML(rawHtml, {
      sanitizer: {
        elements: SAFE_EPUB_ELEMENTS,
        attributes: SAFE_EPUB_ATTRIBUTES,
      },
    });
    return;
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(rawHtml, 'text/html');
  const frag = document.createDocumentFragment();
  for (const child of Array.from(parsed.body.childNodes)) {
    const clean = sanitizeNodeTreeFallback(child, document);
    if (clean) frag.appendChild(clean);
  }
  targetEl.replaceChildren(frag);
}

export class EpubEngine {
  constructor({ viewportEl, containerEl, onPageChange, onAnnotationsRender }) {
    this.viewportEl = viewportEl;
    this.containerEl = containerEl;
    this.onPageChange = onPageChange;
    this.onAnnotationsRender = onAnnotationsRender;

    this.bookId = null;
    this.manifest = null;
    this.numPages = 0;
    this.currentPage = 1;
    this.scale = 1.0;
    this.zoomMode = 'fit-width';
    this.viewMode = 'scroll';
    this.readingDir = 'rtl';

    this.pageShells = new Map();
    this.renderedPages = new Set();
    this.renderingTasks = new Map();
    this.chapterCache = new Map();
    this.observer = null;
    this.searchAbort = null;
  }

  async loadBook(bookId) {
    this.destroy();
    this.bookId = bookId;
    this.manifest = await api.getEpubManifest(bookId);
    this.numPages = Math.max(1, this.manifest.totalChapters || 1);

    return {
      numPages: this.numPages,
      firstPage: null,
    };
  }

  async inspectBookIntelligence() {
    return {
      detectedDir: this.manifest?.readingDir || 'ltr',
      pdfTitle: this.manifest?.title || '',
      pdfAuthor: this.manifest?.author || '',
    };
  }

  async extractCoverDataUrl() {
    return this.manifest?.coverDataUrl || '';
  }

  async extractOutline() {
    return Array.isArray(this.manifest?.toc) ? this.manifest.toc : [];
  }

  getFontScale() {
    if (this.zoomMode === 'fit-width' || this.zoomMode === 'fit-page') {
      return 1.0;
    }
    return Math.max(0.7, Math.min(2.0, this.scale || 1.0));
  }

  buildLayout() {
    if (!this.bookId || !this.manifest) return;
    this.clearRenderedState();
    this.scale = this.getFontScale();

    this.containerEl.classList.toggle('view-spread', false);
    this.containerEl.classList.add('is-epub-mode');
    this.containerEl.dataset.spreadDir = this.readingDir;
    this.containerEl.style.setProperty('--epub-font-scale', String(this.scale));
    this.containerEl.innerHTML = '';
    this.pageShells.clear();

    const visibleSet = this.viewMode === 'scroll' ? null : new Set([this.currentPage]);

    for (let ch = 1; ch <= this.numPages; ch++) {
      if (visibleSet && !visibleSet.has(ch)) continue;

      const shell = document.createElement('article');
      shell.className = 'pdf-page-shell epub-chapter-shell';
      if (this.viewMode === 'spread') {
        shell.classList.add('epub-spread-columns');
      }
      shell.dataset.page = String(ch);
      shell.dir = this.readingDir === 'rtl' ? 'rtl' : 'ltr';

      const body = document.createElement('div');
      body.className = 'epub-chapter-body';
      body.innerHTML = `<p class="epub-loading-hint">در حال بارگذاری فصل ${ch}...</p>`;
      shell.appendChild(body);

      const badge = document.createElement('span');
      badge.className = 'page-badge';
      badge.textContent = `فصل ${ch}`;
      shell.appendChild(badge);

      this.containerEl.appendChild(shell);
      this.pageShells.set(ch, shell);
    }

    if (this.viewMode === 'scroll') {
      this.setupObserver();
    } else {
      for (const ch of this.pageShells.keys()) {
        this.renderPage(ch);
      }
    }
  }

  setupObserver() {
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const ch = Number(entry.target.dataset.page);
          if (entry.isIntersecting) {
            this.renderPage(ch);
          }
        }
        this.updateCurrentPageFromScroll();
      },
      {
        root: this.viewportEl,
        rootMargin: '1200px 0px',
        threshold: [0.02, 0.25],
      }
    );

    for (const shell of this.pageShells.values()) {
      this.observer.observe(shell);
    }
  }

  updateCurrentPageFromScroll() {
    if (this.viewMode !== 'scroll' || this.pageShells.size === 0) return;
    const vpRect = this.viewportEl.getBoundingClientRect();
    const probeY = vpRect.top + Math.min(180, vpRect.height * 0.28);

    let bestPage = this.currentPage;
    let bestDist = Infinity;
    for (const [ch, shell] of this.pageShells.entries()) {
      const r = shell.getBoundingClientRect();
      if (r.top <= probeY && r.bottom >= probeY) {
        bestPage = ch;
        bestDist = 0;
        break;
      }
      const dist = Math.min(Math.abs(r.top - probeY), Math.abs(r.bottom - probeY));
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = ch;
      }
    }
    if (bestPage !== this.currentPage) {
      this.currentPage = bestPage;
      this.onPageChange?.(bestPage);
    }
  }

  async renderPage(chapterNum) {
    if (!this.bookId || this.renderedPages.has(chapterNum) || this.renderingTasks.has(chapterNum)) {
      return;
    }
    const shell = this.pageShells.get(chapterNum);
    if (!shell) return;

    const promise = (async () => {
      try {
        let data = this.chapterCache.get(chapterNum);
        if (!data) {
          data = await api.getEpubChapter(this.bookId, chapterNum);
          this.chapterCache.set(chapterNum, data);
        }
        if (!this.bookId || !this.pageShells.has(chapterNum)) return;

        const dir = data.detectedDir || this.readingDir || 'auto';
        shell.dir = dir;

        shell.querySelector('style.epub-chapter-style')?.remove();
        if (data.css && data.css.trim()) {
          const styleEl = document.createElement('style');
          styleEl.className = 'epub-chapter-style';
          styleEl.textContent = data.css;
          shell.prepend(styleEl);
        }

        const body = shell.querySelector('.epub-chapter-body');
        if (body) {
          body.dir = dir;
          setSafeChapterHTML(body, data.html || '');

          body.addEventListener('click', (e) => {
            const link = e.target.closest('a[data-epub-page]');
            if (!link) return;
            e.preventDefault();
            const targetPage = Number(link.dataset.epubPage);
            const anchor = link.dataset.epubAnchor || '';
            this.goToPage(targetPage, 'smooth', anchor);
          });
        }

        this.renderedPages.add(chapterNum);
        this.onAnnotationsRender?.(chapterNum, shell);
      } catch (err) {
        const body = shell.querySelector('.epub-chapter-body');
        if (body) {
          body.innerHTML = `<p class="epub-loading-hint">خطا در بارگذاری فصل ${chapterNum}: ${err.message}</p>`;
        }
      } finally {
        this.renderingTasks.delete(chapterNum);
      }
    })();

    this.renderingTasks.set(chapterNum, promise);
    return promise;
  }

  async goToPage(pageNum, behavior = 'auto', anchor = '') {
    const target = Math.max(1, Math.min(this.numPages || 1, Number(pageNum) || 1));
    this.currentPage = target;
    this.onPageChange?.(target);

    if (this.viewMode === 'scroll') {
      const shell = this.pageShells.get(target);
      if (shell) {
        const top = Math.max(0, shell.offsetTop - 16);
        this.viewportEl.scrollTo({ top, left: 0, behavior });
        await this.renderPage(target);
        if (anchor) {
          const anchorEl = shell.querySelector(`[id="${CSS.escape(anchor)}"]`);
          if (anchorEl) {
            const relTop = shell.offsetTop + anchorEl.offsetTop - 24;
            this.viewportEl.scrollTo({ top: Math.max(0, relTop), left: 0, behavior });
          }
        }
      }
    } else {
      this.buildLayout();
      this.viewportEl.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      await this.renderPage(target);
      if (anchor) {
        const shell = this.pageShells.get(target);
        const anchorEl = shell?.querySelector(`[id="${CSS.escape(anchor)}"]`);
        if (anchorEl && shell) {
          this.viewportEl.scrollTo({ top: Math.max(0, anchorEl.offsetTop - 24), left: 0, behavior });
        }
      }
    }
  }

  stepPage(delta) {
    this.goToPage(this.currentPage + delta, 'auto');
  }

  async searchBook(query, onMatch, onDone) {
    if (!this.bookId || !query.trim()) return;
    if (this.searchAbort) this.searchAbort.abort = true;
    const token = { abort: false };
    this.searchAbort = token;

    try {
      const res = await api.searchEpub(this.bookId, normalizePersianText(query.trim()));
      if (token.abort) return;
      for (const m of res.matches || []) {
        onMatch({ page: m.page, snippet: m.snippet, chapterTitle: m.chapterTitle });
      }
      onDone(res.total || 0);
    } catch {
      if (!token.abort) onDone(0);
    }
  }

  clearRenderedState() {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    this.renderedPages.clear();
    this.renderingTasks.clear();
  }

  destroy() {
    this.clearRenderedState();
    if (this.searchAbort) this.searchAbort.abort = true;
    if (this.bookId) {
      api.releaseBookResources?.(this.bookId);
    }
    this.containerEl.classList.remove('is-epub-mode');
    this.containerEl.style.removeProperty('--epub-font-scale');
    this.containerEl.innerHTML = '';
    this.pageShells.clear();
    this.chapterCache.clear();
    this.bookId = null;
    this.manifest = null;
  }
}
