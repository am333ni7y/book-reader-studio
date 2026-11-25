import { api } from './api.js';
import { PdfEngine } from './pdf-engine.js';
import { EpubEngine } from './epub-engine.js';
import { AnnotationManager } from './annotations.js';
import { formatFaNum } from './bilingual-text.js';

// Conditional Polyfills per Modern Web Guidance
if (!Object.hasOwn(HTMLElement.prototype, 'popover')) {
  import('https://unpkg.com/@oddbird/popover-polyfill@latest/dist/popover.min.js').catch(() => {});
}

// Mandatory light-dismiss fallback for <dialog closedby="any">
if (!('closedBy' in HTMLDialogElement.prototype)) {
  document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    });
  });
}

// Roving tabindex fallback for focusgroup="toolbar wrap"
function initToolbarFocusgroupFallback(bar) {
  if ('focusGroup' in HTMLElement.prototype || !bar) return;
  const items = Array.from(bar.querySelectorAll('button'));
  if (items.length === 0) return;

  items.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
  bar.addEventListener('focusin', ({ target }) => {
    if (items.includes(target)) {
      items.forEach((b) => (b.tabIndex = b === target ? 0 : -1));
    }
  });

  bar.addEventListener('keydown', (e) => {
    const rtl = getComputedStyle(bar).direction === 'rtl';
    const steps = {
      ArrowRight: rtl ? -1 : 1,
      ArrowLeft: rtl ? 1 : -1,
    };
    const currentIdx = items.indexOf(document.activeElement);
    if (currentIdx === -1) return;

    let nextIdx = null;
    if (Object.hasOwn(steps, e.key)) {
      nextIdx = (currentIdx + steps[e.key] + items.length) % items.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = items.length - 1;
    }

    if (nextIdx !== null) {
      e.preventDefault();
      items[nextIdx].focus();
    }
  });
}

// ==================== APP STATE ====================
const state = {
  books: [],
  activeBook: null,
  bookmarks: [],
  highlights: [],
  customToc: [],
  nativeToc: [],
  hlColorFilter: 'all',
  hlSearchQuery: '',
  dialogHighlightContext: null,
  readingTimer: null,
  savePositionTimeout: null,
};

const el = {
  srStatus: document.getElementById('sr-status'),
  toastRegion: document.getElementById('toast-region'),
  libraryView: document.getElementById('library-view'),
  readerView: document.getElementById('reader-view'),
  booksGrid: document.getElementById('books-grid'),
  emptyLibrary: document.getElementById('empty-library'),
  librarySearch: document.getElementById('library-search'),
  dropZone: document.getElementById('drop-zone'),
  pdfFileInput: document.getElementById('pdf-file-input'),
  uploadProgressWrap: document.getElementById('upload-progress-wrap'),
  uploadProgress: document.getElementById('upload-progress'),
  uploadProgressLabel: document.getElementById('upload-progress-label'),

  readerBookTitle: document.getElementById('reader-book-title'),
  readerChapterCrumb: document.getElementById('reader-chapter-crumb'),
  readerToolbar: document.getElementById('reader-toolbar'),
  readerSidebar: document.getElementById('reader-sidebar'),
  pdfViewport: document.getElementById('pdf-viewport'),
  pdfPagesContainer: document.getElementById('pdf-pages-container'),
  readingProgressFill: document.getElementById('reading-progress-fill'),

  pageNumberInput: document.getElementById('page-number-input'),
  pageTotalLabel: document.getElementById('page-total-label'),
  zoomLabel: document.getElementById('zoom-label'),
  btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
  btnAreaHighlight: document.getElementById('btn-area-highlight'),
  btnRibbonBookmark: document.getElementById('btn-ribbon-bookmark'),
  btnZenMode: document.getElementById('btn-zen-mode'),
  btnExitZen: document.getElementById('btn-exit-zen'),

  tocList: document.getElementById('toc-list'),
  bookmarksList: document.getElementById('bookmarks-list'),
  highlightsList: document.getElementById('highlights-list'),
  bookSearchResults: document.getElementById('book-search-results'),
  bookSearchMeta: document.getElementById('book-search-meta'),

  rangeBrightness: document.getElementById('range-brightness'),
  brightnessOut: document.getElementById('brightness-out'),
  rangeWarmth: document.getElementById('range-warmth'),
  warmthOut: document.getElementById('warmth-out'),
};

function notify(message) {
  el.srStatus.textContent = message;
  const pill = document.createElement('div');
  pill.className = 'toast-pill';
  pill.textContent = message;
  el.toastRegion.appendChild(pill);
  setTimeout(() => pill.remove(), 3200);
}

function closeDialog(id) {
  document.getElementById(id)?.close();
}

document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
  btn.addEventListener('click', () => closeDialog(btn.dataset.closeDialog));
});

// ==================== ENGINES ====================
const annotations = new AnnotationManager({
  viewportEl: el.pdfViewport,
  selectionToolbarEl: document.getElementById('selection-toolbar'),
  onCreateHighlight: async (payload) => {
    const { highlight } = await api.createHighlight(state.activeBook.id, payload);
    state.highlights.push(highlight);
    annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
    rerenderPageOverlay(highlight.page);
    renderHighlightsSidebar();
    notify('هایلایت ذخیره شد.');
  },
  onOpenHighlightDialog: (ctx) => openHighlightDialog(ctx),
  onCopyText: async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('متن در حافظه کپی شد.');
    } catch {
      notify('امکان دسترسی به کلیپ‌بورد وجود ندارد.');
    }
  },
});

const pdfEngine = new PdfEngine({
  viewportEl: el.pdfViewport,
  containerEl: el.pdfPagesContainer,
  onPageChange: (page) => onCurrentPageUpdated(page),
  onAnnotationsRender: (pageNum, shell) => annotations.renderPageOverlays(pageNum, shell),
});

const epubEngine = new EpubEngine({
  viewportEl: el.pdfViewport,
  containerEl: el.pdfPagesContainer,
  onPageChange: (page) => onCurrentPageUpdated(page),
  onAnnotationsRender: (pageNum, shell) => annotations.renderPageOverlays(pageNum, shell),
});

function getEngine() {
  return state.activeBook?.format === 'epub' ? epubEngine : pdfEngine;
}

function getUnitLabel() {
  return state.activeBook?.format === 'epub' ? 'فصل' : 'صفحه';
}

function rerenderPageOverlay(pageNum) {
  const shell = getEngine().pageShells.get(pageNum);
  if (shell) annotations.renderPageOverlays(pageNum, shell);
}

// ==================== UI COLOR SCHEME (Modern Web Guidance) ====================
function syncSchemeButtons() {
  const current = document.querySelector('meta[name="color-scheme"]')?.content || 'light dark';
  document.querySelectorAll('[data-ui-scheme]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.uiScheme === current);
  });
}

document.querySelectorAll('[data-ui-scheme]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const val = btn.dataset.uiScheme;
    document.querySelector('meta[name="color-scheme"]').content = val;
    try {
      if (val === 'light dark') localStorage.removeItem('color-scheme');
      else localStorage.setItem('color-scheme', val);
    } catch {}
    syncSchemeButtons();
  });
});

window.addEventListener('storage', (e) => {
  if (e.key === 'color-scheme') {
    document.querySelector('meta[name="color-scheme"]').content = e.newValue ?? 'light dark';
    syncSchemeButtons();
  }
});

// ==================== LIBRARY / BOOKSHELF ====================
async function loadLibrary() {
  const { books } = await api.listBooks();
  state.books = books;
  renderLibrary();
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function renderLibrary() {
  const q = el.librarySearch.value.trim().toLowerCase();
  const filtered = state.books.filter((b) =>
    !q || b.title.toLowerCase().includes(q) || (b.author || '').toLowerCase().includes(q)
  );

  el.booksGrid.innerHTML = '';
  el.emptyLibrary.hidden = filtered.length > 0;

  for (const book of filtered) {
    const isEpub = book.format === 'epub';
    const unitLabel = isEpub ? 'فصل' : 'صفحه';
    const pct = book.total_pages > 0 ? Math.round((book.current_page / book.total_pages) * 100) : 0;
    const card = document.createElement('article');
    card.className = 'book-card';

    const coverHtml = book.cover_data_url
      ? `<img src="${book.cover_data_url}" alt="جلد ${escapeHtml(book.title)}">`
      : `<div class="book-cover-fallback">${escapeHtml(book.title)}</div>`;

    card.innerHTML = `
      <div class="book-cover-box" data-open-book="${book.id}">
        ${coverHtml}
        <span class="format-badge ${isEpub ? 'is-epub' : ''}">${isEpub ? 'EPUB' : 'PDF'}</span>
      </div>
      <div class="book-card-body">
        <h3 class="book-card-title" dir="auto" data-open-book="${book.id}">${escapeHtml(book.title)}</h3>
        <div class="book-card-meta">
          <span>${book.total_pages ? `${formatFaNum(book.total_pages)} ${unitLabel}` : formatSize(book.file_size)}</span>
          <span>${formatFaNum(pct)}% مطالعه</span>
        </div>
        <div class="book-progress-bar"><span style="width:${pct}%"></span></div>
        <div class="book-card-meta">
          <span>${formatFaNum(book.highlight_count || 0)} هایلایت</span>
          <span>${formatFaNum(book.bookmark_count || 0)} نشان</span>
        </div>
        <div class="book-card-footer">
          <button type="button" class="btn btn-xs btn-primary" data-open-book="${book.id}">ادامه مطالعه</button>
          <button type="button" class="btn btn-xs btn-secondary" data-delete-book="${book.id}" aria-label="حذف کتاب">حذف</button>
        </div>
      </div>
    `;

    card.querySelectorAll('[data-open-book]').forEach((node) => {
      node.addEventListener('click', () => openBook(book.id));
    });
    card.querySelector('[data-delete-book]')?.addEventListener('click', async () => {
      if (!confirm(`آیا کتاب «${book.title}» حذف شود؟`)) return;
      await api.deleteBook(book.id);
      notify('کتاب از کتابخانه حذف شد.');
      await loadLibrary();
    });

    el.booksGrid.appendChild(card);
  }
}

async function handlePdfFiles(files) {
  const books = Array.from(files).filter((f) => {
    const name = f.name.toLowerCase();
    return name.endsWith('.pdf') || name.endsWith('.epub') || f.type === 'application/pdf' || f.type === 'application/epub+zip';
  });
  if (books.length === 0) {
    notify('لطفاً یک فایل PDF یا EPUB معتبر انتخاب کنید.');
    return;
  }

  el.uploadProgressWrap.hidden = false;
  for (const file of books) {
    el.uploadProgressLabel.textContent = `در حال افزودن ${file.name}...`;
    el.uploadProgress.value = 0;
    try {
      await api.uploadBookFile(file, (pct) => {
        el.uploadProgress.value = pct;
      });
      notify(`کتاب «${file.name}» با موفقیت اضافه شد.`);
    } catch (err) {
      notify(err.message);
    }
  }
  el.uploadProgressWrap.hidden = true;
  await loadLibrary();
}

el.librarySearch.addEventListener('input', renderLibrary);
el.pdfFileInput.addEventListener('change', (e) => {
  if (e.target.files?.length) handlePdfFiles(e.target.files);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((ev) => {
  el.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropZone.classList.add('is-dragover');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  el.dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    el.dropZone.classList.remove('is-dragover');
  });
});
el.dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) handlePdfFiles(e.dataTransfer.files);
});

document.getElementById('btn-open-import-path').addEventListener('click', () => {
  document.getElementById('import-path-form').reset();
  document.getElementById('import-dialog').showModal();
});

document.getElementById('import-path-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const filePath = document.getElementById('import-path-input').value.trim();
  const title = document.getElementById('import-title-input').value.trim();
  try {
    await api.importFromPath(filePath, title);
    closeDialog('import-dialog');
    notify('کتاب با موفقیت از مسیر محلی اضافه شد.');
    await loadLibrary();
  } catch (err) {
    notify(err.message);
  }
});

// ==================== READER LIFECYCLE ====================
const APP_ROOT_TITLE = 'کتاب‌خان استودیو | کتاب‌خوان حرفه‌ای PDF و EPUB';
let hasInAppRootEntry = false;
let currentHistoryDepth = 0;
let lastReturnBookId = null;

async function openBook(bookId, { pushHistory = true } = {}) {
  try {
    lastReturnBookId = bookId;
    if (pushHistory && location.pathname !== `/book/${encodeURIComponent(bookId)}`) {
      currentHistoryDepth += 1;
      history.pushState(
        { view: 'book', bookId, depth: currentHistoryDepth },
        '',
        `/book/${encodeURIComponent(bookId)}`
      );
    }

    const data = await api.getBook(bookId);
    state.activeBook = data.book;
    state.bookmarks = data.bookmarks;
    state.highlights = data.highlights;
    state.customToc = data.tocEntries;

    el.libraryView.hidden = true;
    el.libraryView.toggleAttribute('inert', true);
    el.readerView.hidden = false;
    el.readerView.toggleAttribute('inert', false);
    el.readerBookTitle.textContent = state.activeBook.title;
    document.title = `${state.activeBook.title} | کتاب‌خان استودیو`;
    document.getElementById('btn-back-library')?.focus({ preventScroll: true });

    annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
    annotations.setAreaMode(false);
    const isEpub = state.activeBook.format === 'epub';
    el.btnAreaHighlight.hidden = isEpub;
    el.btnAreaHighlight.setAttribute('aria-pressed', 'false');

    // Auto-collapse sidebar on mobile / Android viewports
    if (window.innerWidth <= 820) {
      el.readerSidebar.hidden = true;
      el.btnToggleSidebar.setAttribute('aria-pressed', 'false');
    } else {
      el.readerSidebar.hidden = false;
      el.btnToggleSidebar.setAttribute('aria-pressed', 'true');
    }

    // Wait 1 animation frame so viewportEl.clientWidth is 100% settled
    await new Promise((r) => requestAnimationFrame(r));

    const engine = getEngine();
    pdfEngine.destroy();
    epubEngine.destroy();
    const { numPages, firstPage } = await engine.loadBook(bookId);
    if (!state.activeBook || state.activeBook.id !== bookId) return;

    const intel = await engine.inspectBookIntelligence(firstPage);
    const patch = { last_opened_at: new Date().toISOString() };

    if (!state.activeBook.total_pages || state.activeBook.total_pages !== numPages) {
      state.activeBook.total_pages = numPages;
      patch.total_pages = numPages;
    }

    // Auto-detect book direction on first open (or if untouched)
    if (state.activeBook.last_opened_at === state.activeBook.created_at && intel.detectedDir) {
      state.activeBook.reading_dir = intel.detectedDir;
      patch.reading_dir = intel.detectedDir;
    }

    // Upgrade slugified filename title from metadata if clean
    const looksSlugified = state.activeBook.title.includes('WEB') || state.activeBook.title === state.activeBook.filename.replace(/\.(pdf|epub)$/i, '').replace(/[_-]+/g, ' ').trim();
    if (looksSlugified && intel.pdfTitle && intel.pdfTitle.length >= 3) {
      state.activeBook.title = intel.pdfTitle;
      el.readerBookTitle.textContent = intel.pdfTitle;
      document.title = `${intel.pdfTitle} | کتاب‌خان استودیو`;
      patch.title = intel.pdfTitle;
    }

    // Apply book reading preferences
    engine.zoomMode = state.activeBook.zoom_mode || 'fit-width';
    engine.scale = state.activeBook.zoom_scale || (isEpub ? 1.0 : 1.25);
    engine.viewMode = state.activeBook.view_mode || 'scroll';
    engine.readingDir = state.activeBook.reading_dir || intel.detectedDir || 'ltr';
    engine.currentPage = state.activeBook.current_page || 1;

    applyPageAppearance();
    syncViewButtons();

    el.pageTotalLabel.textContent = String(numPages);
    el.pageNumberInput.max = String(numPages);

    if (!state.activeBook.cover_data_url) {
      try {
        const cover = await engine.extractCoverDataUrl(firstPage);
        if (cover) {
          state.activeBook.cover_data_url = cover;
          patch.cover_data_url = cover;
        }
      } catch {}
    }
    api.updateBook(bookId, patch).catch(() => {});

    engine.buildLayout();
    updateZoomLabel();

    if (engine.currentPage > 1) {
      engine.goToPage(engine.currentPage, 'auto');
    } else {
      onCurrentPageUpdated(1);
    }

    state.nativeToc = await engine.extractOutline();
    renderTocSidebar();
    renderBookmarksSidebar();
    renderHighlightsSidebar();

    clearInterval(state.readingTimer);
    state.readingTimer = setInterval(() => {
      if (!el.readerView.hidden && state.activeBook && !document.hidden) {
        state.activeBook.reading_seconds = (state.activeBook.reading_seconds || 0) + 15;
        api.updateBook(state.activeBook.id, { reading_seconds: state.activeBook.reading_seconds }).catch(() => {});
      }
    }, 15000);
  } catch (err) {
    notify(`خطا در باز کردن کتاب: ${err.message}`);
    if (location.pathname !== '/') {
      history.replaceState({ view: 'library', depth: currentHistoryDepth }, '', '/');
    }
    backToLibrary();
  }
}

function backToLibrary() {
  // 1. Synchronous UI transition first (0ms, cannot fail)
  const returnId = state.activeBook?.id || lastReturnBookId;
  clearInterval(state.readingTimer);
  clearTimeout(state.savePositionTimeout);
  document.body.classList.remove('is-zen');
  el.btnExitZen.hidden = true;
  el.readerView.hidden = true;
  el.readerView.toggleAttribute('inert', true);
  el.libraryView.hidden = false;
  el.libraryView.toggleAttribute('inert', false);
  state.activeBook = null;
  document.title = APP_ROOT_TITLE;

  // 2. Cleanup engines safely
  try {
    pdfEngine.destroy();
    epubEngine.destroy();
  } catch {}

  // 3. Refresh shelf counts asynchronously and restore focus
  loadLibrary()
    .then(() => {
      const target = returnId
        ? el.booksGrid.querySelector(`button[data-open-book="${CSS.escape(returnId)}"]`)
        : null;
      (target || el.librarySearch)?.focus({ preventScroll: true });
    })
    .catch(() => {});
}

function navigateBackToLibrary() {
  if (hasInAppRootEntry && currentHistoryDepth > 0) {
    history.back();
  } else {
    // Landed directly on deep link /book/:id -> synthesize root entry
    hasInAppRootEntry = true;
    currentHistoryDepth += 1;
    history.pushState({ view: 'library', depth: currentHistoryDepth }, '', '/');
    backToLibrary();
  }
}

document.getElementById('btn-back-library').addEventListener('click', navigateBackToLibrary);

function onCurrentPageUpdated(page) {
  if (!state.activeBook) return;
  state.activeBook.current_page = page;
  el.pageNumberInput.value = String(page);

  const engine = getEngine();
  const unitLabel = getUnitLabel();
  const total = engine.numPages || 1;
  const pct = Math.round((page / total) * 100);
  el.readingProgressFill.style.width = `${pct}%`;

  const hasRibbon = state.bookmarks.some((b) => b.page === page && b.kind === 'ribbon');
  el.btnRibbonBookmark.setAttribute('aria-pressed', String(hasRibbon));

  // Update active chapter breadcrumb
  const combined = getCombinedToc();
  let activeChapter = '';
  for (const item of combined) {
    if (item.page <= page) activeChapter = item.title;
  }
  el.readerChapterCrumb.textContent = activeChapter ? `${activeChapter} • ${unitLabel} ${page}` : `${unitLabel} ${page}`;

  renderTocHighlightActive(page);

  clearTimeout(state.savePositionTimeout);
  state.savePositionTimeout = setTimeout(() => {
    if (state.activeBook) {
      api.updateBook(state.activeBook.id, { current_page: page }).catch(() => {});
    }
  }, 500);
}

// ==================== TOOLBAR CONTROLS ====================
el.pdfViewport.addEventListener('scroll', () => {
  getEngine().updateCurrentPageFromScroll();
}, { passive: true });

document.getElementById('btn-prev-page').addEventListener('click', () => getEngine().stepPage(-1));
document.getElementById('btn-next-page').addEventListener('click', () => getEngine().stepPage(1));

el.pageNumberInput.addEventListener('change', () => {
  getEngine().goToPage(Number(el.pageNumberInput.value), 'auto');
});

function updateZoomLabel() {
  el.zoomLabel.textContent = `${Math.round(getEngine().scale * 100)}%`;
}

document.getElementById('btn-zoom-in').addEventListener('click', () => {
  const engine = getEngine();
  const isEpub = state.activeBook?.format === 'epub';
  engine.zoomMode = 'custom';
  engine.scale = Math.min(isEpub ? 2.0 : 2.6, engine.scale + (isEpub ? 0.1 : 0.15));
  engine.buildLayout();
  updateZoomLabel();
  api.updateBook(state.activeBook.id, { zoom_mode: 'custom', zoom_scale: engine.scale }).catch(() => {});
});

document.getElementById('btn-zoom-out').addEventListener('click', () => {
  const engine = getEngine();
  const isEpub = state.activeBook?.format === 'epub';
  engine.zoomMode = 'custom';
  engine.scale = Math.max(isEpub ? 0.75 : 0.45, engine.scale - (isEpub ? 0.1 : 0.15));
  engine.buildLayout();
  updateZoomLabel();
  api.updateBook(state.activeBook.id, { zoom_mode: 'custom', zoom_scale: engine.scale }).catch(() => {});
});

document.getElementById('btn-zoom-fit').addEventListener('click', () => {
  const engine = getEngine();
  engine.zoomMode = engine.zoomMode === 'fit-width' ? 'fit-page' : 'fit-width';
  engine.buildLayout();
  updateZoomLabel();
  api.updateBook(state.activeBook.id, { zoom_mode: engine.zoomMode }).catch(() => {});
});

function syncViewButtons() {
  const mode = getEngine().viewMode;
  document.getElementById('btn-view-scroll').setAttribute('aria-pressed', String(mode === 'scroll'));
  document.getElementById('btn-view-single').setAttribute('aria-pressed', String(mode === 'single'));
  document.getElementById('btn-view-spread').setAttribute('aria-pressed', String(mode === 'spread'));
}

['scroll', 'single', 'spread'].forEach((mode) => {
  document.getElementById(`btn-view-${mode}`).addEventListener('click', () => {
    const engine = getEngine();
    engine.viewMode = mode;
    syncViewButtons();
    engine.buildLayout();
    updateZoomLabel();
    api.updateBook(state.activeBook.id, { view_mode: mode }).catch(() => {});
  });
});

el.btnAreaHighlight.addEventListener('click', () => {
  if (state.activeBook?.format === 'epub') return;
  const next = !annotations.areaMode;
  annotations.setAreaMode(next);
  el.btnAreaHighlight.setAttribute('aria-pressed', String(next));
  notify(next ? 'حالت هایلایت ناحیه‌ای فعال شد: روی صفحه کادر بکشید.' : 'حالت انتخاب متن فعال شد.');
});

async function toggleCurrentPageRibbon() {
  if (!state.activeBook) return;
  const page = getEngine().currentPage;
  const res = await api.toggleRibbonBookmark(state.activeBook.id, page);
  if (res.removed) {
    state.bookmarks = state.bookmarks.filter((b) => b.id !== res.id);
    notify(`بوکمارک صفحه ${page} برداشته شد.`);
  } else {
    state.bookmarks.push(res.bookmark);
    notify(`صفحه ${page} بوکمارک شد.`);
  }
  annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
  rerenderPageOverlay(page);
  renderBookmarksSidebar();
  onCurrentPageUpdated(page);
}

el.btnRibbonBookmark.addEventListener('click', toggleCurrentPageRibbon);

// ==================== APPEARANCE & PAGE FILTERS ====================
function applyPageAppearance() {
  const b = state.activeBook;
  if (!b) return;
  el.pdfViewport.dataset.pageTheme = b.page_theme || 'paper';
  document.documentElement.style.setProperty('--page-brightness', String((b.brightness || 100) / 100));
  document.documentElement.style.setProperty('--page-warmth', String((b.warmth || 0) / 100));

  el.rangeBrightness.value = String(b.brightness || 100);
  el.brightnessOut.textContent = `${b.brightness || 100}%`;
  el.rangeWarmth.value = String(b.warmth || 0);
  el.warmthOut.textContent = `${b.warmth || 0}%`;

  document.querySelectorAll('[data-page-theme]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.pageTheme === (b.page_theme || 'paper'));
  });
  document.querySelectorAll('[data-reading-dir]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.readingDir === (b.reading_dir || 'rtl'));
  });
}

document.querySelectorAll('[data-page-theme]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.activeBook) return;
    state.activeBook.page_theme = btn.dataset.pageTheme;
    applyPageAppearance();
    api.updateBook(state.activeBook.id, { page_theme: state.activeBook.page_theme }).catch(() => {});
  });
});

document.querySelectorAll('[data-reading-dir]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.activeBook) return;
    const engine = getEngine();
    state.activeBook.reading_dir = btn.dataset.readingDir;
    engine.readingDir = state.activeBook.reading_dir;
    applyPageAppearance();
    engine.buildLayout();
    api.updateBook(state.activeBook.id, { reading_dir: state.activeBook.reading_dir }).catch(() => {});
  });
});

el.rangeBrightness.addEventListener('input', () => {
  if (!state.activeBook) return;
  state.activeBook.brightness = Number(el.rangeBrightness.value);
  applyPageAppearance();
});
el.rangeBrightness.addEventListener('change', () => {
  if (state.activeBook) api.updateBook(state.activeBook.id, { brightness: state.activeBook.brightness }).catch(() => {});
});

el.rangeWarmth.addEventListener('input', () => {
  if (!state.activeBook) return;
  state.activeBook.warmth = Number(el.rangeWarmth.value);
  applyPageAppearance();
});
el.rangeWarmth.addEventListener('change', () => {
  if (state.activeBook) api.updateBook(state.activeBook.id, { warmth: state.activeBook.warmth }).catch(() => {});
});

// ==================== SIDEBAR TABS & CONTENT ====================
function activateSidebarTab(tabId) {
  el.readerSidebar.hidden = false;
  el.btnToggleSidebar.setAttribute('aria-pressed', 'true');
  document.querySelectorAll('.sidebar-tab').forEach((t) => {
    const selected = t.id === tabId;
    t.setAttribute('aria-selected', String(selected));
    const panel = document.getElementById(t.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  });
}

document.querySelectorAll('.sidebar-tab').forEach((tab) => {
  tab.addEventListener('click', () => activateSidebarTab(tab.id));
});

el.btnToggleSidebar.addEventListener('click', () => {
  const nextHidden = !el.readerSidebar.hidden;
  el.readerSidebar.hidden = nextHidden;
  el.btnToggleSidebar.setAttribute('aria-pressed', String(!nextHidden));
});

document.getElementById('btn-toggle-search').addEventListener('click', () => {
  activateSidebarTab('tab-search');
  document.getElementById('book-search-input').focus();
});

function getCombinedToc() {
  const custom = state.customToc.map((c) => ({ ...c, isNative: false }));
  return [...state.nativeToc, ...custom].sort((a, b) => a.page - b.page);
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 820) {
    el.readerSidebar.hidden = true;
    el.btnToggleSidebar.setAttribute('aria-pressed', 'false');
  }
}

function renderTocSidebar() {
  const items = getCombinedToc();
  el.tocList.innerHTML = '';

  if (items.length === 0) {
    el.tocList.innerHTML = `<p class="panel-hint">این کتاب فهرست داخلی ندارد. با دکمه «+ سرفصل جدید» می‌توانید فهرست اختصاصی خودتان را بسازید.</p>`;
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'toc-row';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toc-item';
    btn.dataset.tocPage = String(item.page);
    btn.style.paddingInlineStart = `${0.55 + (item.level || 0) * 0.95}rem`;
    btn.innerHTML = `<span class="toc-item-title" dir="auto">${escapeHtml(item.title)}</span><span class="toc-item-page">${item.page}</span>`;
    btn.addEventListener('click', () => {
      getEngine().goToPage(item.page, 'auto', item.anchor || '');
      closeSidebarOnMobile();
    });
    row.appendChild(btn);

    if (!item.isNative) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-icon';
      del.textContent = '×';
      del.title = 'حذف سرفصل';
      del.addEventListener('click', async () => {
        await api.deleteTocEntry(item.id);
        state.customToc = state.customToc.filter((c) => c.id !== item.id);
        renderTocSidebar();
      });
      row.appendChild(del);
    }

    el.tocList.appendChild(row);
  }
  renderTocHighlightActive(getEngine().currentPage);
}

function renderTocHighlightActive(page) {
  let activeBtn = null;
  el.tocList.querySelectorAll('.toc-item').forEach((btn) => {
    btn.classList.remove('is-active');
    if (Number(btn.dataset.tocPage) <= page) activeBtn = btn;
  });
  activeBtn?.classList.add('is-active');
}

function renderBookmarksSidebar() {
  el.bookmarksList.innerHTML = '';
  if (state.bookmarks.length === 0) {
    el.bookmarksList.innerHTML = `<p class="panel-hint">هنوز صفحه‌ای نشان‌گذاری نشده است. کلید B یا P را بزنید.</p>`;
    return;
  }

  const unitLabel = getUnitLabel();
  for (const bm of state.bookmarks) {
    const card = document.createElement('div');
    card.className = 'annotation-card';
    const badgeText = bm.kind === 'pin' ? `📌 ${bm.category || 'کلیدی'}` : '🔖 بوکمارک سریع';
    card.innerHTML = `
      <div class="annotation-card-head">
        <span class="annotation-badge">${escapeHtml(badgeText)}</span>
        <span>${unitLabel} ${bm.page}</span>
      </div>
      ${bm.label ? `<strong>${escapeHtml(bm.label)}</strong>` : ''}
      ${bm.note ? `<p class="annotation-note">${escapeHtml(bm.note)}</p>` : ''}
      <div style="display:flex;justify-content:flex-end;">
        <button type="button" class="btn btn-xs btn-secondary" data-del-bm="${bm.id}">حذف</button>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-del-bm]')) return;
      getEngine().goToPage(bm.page);
      closeSidebarOnMobile();
    });
    card.querySelector('[data-del-bm]').addEventListener('click', async () => {
      await api.deleteBookmark(bm.id);
      state.bookmarks = state.bookmarks.filter((b) => b.id !== bm.id);
      annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
      rerenderPageOverlay(bm.page);
      renderBookmarksSidebar();
      onCurrentPageUpdated(getEngine().currentPage);
    });
    el.bookmarksList.appendChild(card);
  }
}

function renderHighlightsSidebar() {
  const q = state.hlSearchQuery.trim().toLowerCase();
  const filtered = state.highlights.filter((h) => {
    if (state.hlColorFilter !== 'all' && h.color !== state.hlColorFilter) return false;
    if (!q) return true;
    return (h.quote_text || '').toLowerCase().includes(q) || (h.note || '').toLowerCase().includes(q);
  });

  el.highlightsList.innerHTML = '';
  if (filtered.length === 0) {
    el.highlightsList.innerHTML = `<p class="panel-hint">هایلایتی برای نمایش وجود ندارد. متنی را انتخاب کنید یا ابزار هایلایت ناحیه‌ای را بزنید.</p>`;
    return;
  }

  const unitLabel = getUnitLabel();
  for (const hl of filtered) {
    const card = document.createElement('div');
    card.className = 'annotation-card';
    card.innerHTML = `
      <div class="annotation-card-head">
        <span class="annotation-badge"><span class="hl-swatch swatch-${hl.color}" style="width:10px;height:10px;"></span>${hl.kind === 'area' ? 'ناحیه‌ای' : 'متنی'}</span>
        <span>${unitLabel} ${hl.page}</span>
      </div>
      ${hl.quote_text ? `<blockquote class="annotation-quote" dir="auto">${escapeHtml(hl.quote_text)}</blockquote>` : ''}
      ${hl.note ? `<p class="annotation-note" dir="auto">${escapeHtml(hl.note)}</p>` : ''}
    `;
    card.addEventListener('click', () => {
      getEngine().goToPage(hl.page);
      closeSidebarOnMobile();
    });
    el.highlightsList.appendChild(card);
  }
}

document.getElementById('highlight-search-input').addEventListener('input', (e) => {
  state.hlSearchQuery = e.target.value;
  renderHighlightsSidebar();
});

document.querySelectorAll('[data-filter-color]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.hlColorFilter = btn.dataset.filterColor;
    document.querySelectorAll('[data-filter-color]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderHighlightsSidebar();
  });
});

// ==================== DIALOGS (PIN, HIGHLIGHT, TOC) ====================
function openPinDialog() {
  if (!state.activeBook) return;
  document.getElementById('pin-page-form').reset();
  document.getElementById('pin-dialog-page-num').textContent = String(getEngine().currentPage);
  document.getElementById('pin-page-dialog').showModal();
}

document.getElementById('btn-pin-page').addEventListener('click', openPinDialog);
document.getElementById('btn-pin-from-sidebar').addEventListener('click', openPinDialog);

document.getElementById('pin-page-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const page = getEngine().currentPage;
  const label = document.getElementById('pin-label-input').value.trim();
  const category = document.getElementById('pin-category-select').value;
  const note = document.getElementById('pin-note-input').value.trim();

  const { bookmark } = await api.createPinBookmark(state.activeBook.id, { page, label, category, note });
  state.bookmarks.push(bookmark);
  annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
  rerenderPageOverlay(page);
  renderBookmarksSidebar();
  closeDialog('pin-page-dialog');
  notify(`صفحه ${page} با برچسب «${label}» نشان‌گذاری شد.`);
});

function openHighlightDialog({ isNew, highlight }) {
  state.dialogHighlightContext = { isNew, highlight, selectedColor: highlight.color || 'amber' };
  const quoteEl = document.getElementById('hl-dialog-quote');
  if (highlight.quote_text) {
    quoteEl.textContent = highlight.quote_text;
    quoteEl.hidden = false;
  } else {
    quoteEl.hidden = true;
  }
  document.getElementById('hl-note-textarea').value = highlight.note || '';
  document.getElementById('btn-delete-highlight').hidden = isNew;
  syncHlDialogSwatches();
  document.getElementById('highlight-note-dialog').showModal();
}

function syncHlDialogSwatches() {
  const c = state.dialogHighlightContext?.selectedColor;
  document.querySelectorAll('[data-dialog-color]').forEach((btn) => {
    btn.classList.toggle('is-selected', btn.dataset.dialogColor === c);
  });
}

document.querySelectorAll('[data-dialog-color]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!state.dialogHighlightContext) return;
    state.dialogHighlightContext.selectedColor = btn.dataset.dialogColor;
    syncHlDialogSwatches();
  });
});

document.getElementById('highlight-note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ctx = state.dialogHighlightContext;
  if (!ctx) return;

  const note = document.getElementById('hl-note-textarea').value.trim();
  const color = ctx.selectedColor;

  if (ctx.isNew) {
    const { highlight } = await api.createHighlight(state.activeBook.id, {
      ...ctx.highlight,
      color,
      note,
    });
    state.highlights.push(highlight);
    rerenderPageOverlay(highlight.page);
    notify('هایلایت و یادداشت ذخیره شد.');
  } else {
    const { highlight } = await api.updateHighlight(ctx.highlight.id, { color, note });
    const idx = state.highlights.findIndex((h) => h.id === highlight.id);
    if (idx !== -1) state.highlights[idx] = highlight;
    rerenderPageOverlay(highlight.page);
    notify('یادداشت به‌روزرسانی شد.');
  }

  annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
  renderHighlightsSidebar();
  closeDialog('highlight-note-dialog');
});

document.getElementById('btn-delete-highlight').addEventListener('click', async () => {
  const ctx = state.dialogHighlightContext;
  if (!ctx || ctx.isNew) return;
  const hl = ctx.highlight;
  await api.deleteHighlight(hl.id);
  state.highlights = state.highlights.filter((h) => h.id !== hl.id);
  annotations.setData({ highlights: state.highlights, bookmarks: state.bookmarks });
  rerenderPageOverlay(hl.page);
  renderHighlightsSidebar();
  closeDialog('highlight-note-dialog');
  notify('هایلایت حذف شد.');
});

// Custom TOC Dialog
document.getElementById('btn-add-toc').addEventListener('click', () => {
  document.getElementById('toc-form').reset();
  document.getElementById('toc-page-input').value = String(getEngine().currentPage);
  document.getElementById('toc-dialog').showModal();
});

document.getElementById('toc-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = document.getElementById('toc-title-input').value.trim();
  const page = Number(document.getElementById('toc-page-input').value) || 1;
  const level = Number(document.getElementById('toc-level-select').value) || 0;
  const { tocEntry } = await api.createTocEntry(state.activeBook.id, { title, page, level });
  state.customToc.push(tocEntry);
  renderTocSidebar();
  closeDialog('toc-dialog');
  notify(`سرفصل «${title}» به فهرست اضافه شد.`);
});

// ==================== IN-BOOK SEARCH & OBSIDIAN EXPORT ====================
document.getElementById('book-search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('book-search-input').value.trim();
  if (!q) return;
  el.bookSearchResults.innerHTML = '';
  el.bookSearchMeta.textContent = 'در حال جستجو در صفحات...';

  const unitLabel = getUnitLabel();
  await getEngine().searchBook(
    q,
    ({ page, snippet, chapterTitle }) => {
      const card = document.createElement('div');
      card.className = 'annotation-card';
      card.innerHTML = `
        <div class="annotation-card-head"><span>${chapterTitle ? escapeHtml(chapterTitle) : `${unitLabel} ${page}`}</span></div>
        <p class="annotation-note" dir="auto">${escapeHtml(snippet)}</p>
      `;
      card.addEventListener('click', () => {
        getEngine().goToPage(page);
        closeSidebarOnMobile();
      });
      el.bookSearchResults.appendChild(card);
    },
    (total) => {
      el.bookSearchMeta.textContent = total > 0 ? `${total} نتیجه پیدا شد.` : 'نتیجه‌ای پیدا نشد.';
    }
  );
});

document.getElementById('btn-export-obsidian').addEventListener('click', async () => {
  if (!state.activeBook) return;
  try {
    const res = await api.exportObsidian(state.activeBook.id);
    notify(`یادداشت‌ها در Obsidian ذخیره شد (${res.savedPath})`);
  } catch (err) {
    notify(`خطا در خروجی: ${err.message}`);
  }
});

// Edit book title inline
el.readerBookTitle.addEventListener('click', async () => {
  if (!state.activeBook) return;
  const next = prompt('نام جدید کتاب:', state.activeBook.title);
  if (next && next.trim() && next.trim() !== state.activeBook.title) {
    state.activeBook.title = next.trim();
    el.readerBookTitle.textContent = state.activeBook.title;
    await api.updateBook(state.activeBook.id, { title: state.activeBook.title });
    notify('نام کتاب به‌روزرسانی شد.');
  }
});

// Zen Mode & Keyboard Shortcuts
function toggleZenMode(force) {
  const next = force ?? !document.body.classList.contains('is-zen');
  document.body.classList.toggle('is-zen', next);
  el.btnExitZen.hidden = !next;
  el.btnZenMode.setAttribute('aria-pressed', String(next));
}

el.btnZenMode.addEventListener('click', () => toggleZenMode());
el.btnExitZen.addEventListener('click', () => toggleZenMode(false));

document.addEventListener('keydown', (e) => {
  if (el.readerView.hidden) return;
  const tag = document.activeElement?.tagName;
  const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    activateSidebarTab('tab-search');
    document.getElementById('book-search-input').focus();
    return;
  }

  if (e.key === 'Escape') {
    if (document.body.classList.contains('is-zen')) {
      toggleZenMode(false);
      return;
    }
    if (!document.querySelector('dialog[open]') && !document.querySelector('[popover]:popover-open')) {
      e.preventDefault();
      navigateBackToLibrary();
      return;
    }
  }

  if (isTyping || document.querySelector('dialog[open]')) return;

  const key = e.key.toLowerCase();
  if (key === 'b') {
    e.preventDefault();
    toggleCurrentPageRibbon();
  } else if (key === 'p') {
    e.preventDefault();
    openPinDialog();
  } else if (key === 't') {
    e.preventDefault();
    el.btnToggleSidebar.click();
  } else if (key === 'f') {
    e.preventDefault();
    toggleZenMode();
  } else if (key === 'j' || (getEngine().viewMode !== 'scroll' && e.key === 'ArrowLeft')) {
    getEngine().stepPage(getEngine().readingDir === 'rtl' ? 1 : -1);
  } else if (key === 'k' || (getEngine().viewMode !== 'scroll' && e.key === 'ArrowRight')) {
    getEngine().stepPage(getEngine().readingDir === 'rtl' ? -1 : 1);
  }
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== RESIZE & HISTORY ROUTING ====================
let resizeTimer = null;
const viewportResizeObserver = new ResizeObserver(() => {
  if (el.readerView.hidden || !state.activeBook) return;
  const engine = getEngine();
  if (engine.zoomMode !== 'fit-width' && engine.zoomMode !== 'fit-page') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.activeBook) return;
    const activeEngine = getEngine();
    activeEngine.buildLayout();
    updateZoomLabel();
    if (activeEngine.viewMode === 'scroll' && activeEngine.currentPage > 1) {
      activeEngine.goToPage(activeEngine.currentPage, 'auto');
    }
  }, 180);
});
viewportResizeObserver.observe(el.pdfViewport);

// ==================== PROGRESSIVE PWA INSTALL (Modern Web Guidance) ====================
const installButton = document.getElementById('btn-install-app');
const supportsWebInstall = typeof Navigator !== 'undefined' && typeof Navigator.prototype.install === 'function';
let deferredInstallPrompt;

if (installButton && supportsWebInstall) {
  installButton.hidden = false;
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installButton && !supportsWebInstall) {
    installButton.hidden = false;
  }
});

installButton?.addEventListener('click', async () => {
  if (installButton.getAttribute('aria-disabled') === 'true') return;
  installButton.setAttribute('aria-disabled', 'true');
  try {
    if (supportsWebInstall) {
      await navigator.install();
      notify('اپلیکیشن با موفقیت نصب شد.');
      installButton.hidden = true;
    } else if (deferredInstallPrompt) {
      const promptEvent = deferredInstallPrompt;
      deferredInstallPrompt = undefined;
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      notify(outcome === 'accepted' ? 'اپلیکیشن نصب شد.' : 'نصب لغو شد.');
      if (!deferredInstallPrompt) installButton.hidden = true;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      notify('نصب لغو شد یا کامل نشد.');
    } else {
      notify('امکان نصب اپلیکیشن وجود ندارد.');
    }
  } finally {
    installButton.removeAttribute('aria-disabled');
  }
});

function syncRouteFromLocation(event) {
  if (typeof event?.state?.depth === 'number') {
    currentHistoryDepth = event.state.depth;
  }
  const m = location.pathname.match(/^\/book\/([^/]+)$/);
  if (m) {
    openBook(decodeURIComponent(m[1]), { pushHistory: false });
  } else {
    hasInAppRootEntry = true;
    if (!el.readerView.hidden) {
      backToLibrary();
    } else {
      el.readerView.toggleAttribute('inert', true);
      el.libraryView.toggleAttribute('inert', false);
      document.title = APP_ROOT_TITLE;
      loadLibrary();
    }
  }
}

window.addEventListener('popstate', syncRouteFromLocation);

// ==================== BOOT ====================
initToolbarFocusgroupFallback(el.readerToolbar);
syncSchemeButtons();
if (/^\/book\/[^/]+$/.test(location.pathname)) {
  hasInAppRootEntry = false;
  currentHistoryDepth = 0;
  history.replaceState({ view: 'book', depth: 0 }, '');
} else {
  hasInAppRootEntry = true;
  currentHistoryDepth = 0;
  history.replaceState({ view: 'library', depth: 0 }, '');
}
syncRouteFromLocation();
