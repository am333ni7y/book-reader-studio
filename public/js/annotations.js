// Dual-mode Highlighting (PDF Text + Area + Reflowable EPUB Text) & Bookmark Ribbons
import { extractCleanSelectionText, normalizePersianText, RTL_CHAR_RE } from './bilingual-text.js';
import { inkStrokes, inkAnchor, strokeOutlinePath, inkColorHex } from './ink-core.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function getEpubTextNodes(rootEl) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let offset = 0;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue?.length || 0;
    if (len > 0) {
      nodes.push({ node, start: offset, end: offset + len });
      offset += len;
    }
  }
  return { nodes, totalLength: offset };
}

export function getOffsetInRoot(rootEl, targetNode, targetOffset) {
  const { nodes } = getEpubTextNodes(rootEl);
  for (const item of nodes) {
    if (item.node === targetNode) {
      return item.start + Math.min(targetOffset, item.end - item.start);
    }
  }
  // If selection starts/ends on an Element node, compute via Range
  try {
    const r = document.createRange();
    r.selectNodeContents(rootEl);
    r.setEnd(targetNode, targetOffset);
    return r.toString().length;
  } catch {
    return -1;
  }
}

// Range covering [start, end) character offsets of an EPUB chapter body (null when out of range).
export function rangeAtOffsets(rootEl, start, end) {
  const { nodes } = getEpubTextNodes(rootEl);
  let startPos = null;
  let endPos = null;
  for (const item of nodes) {
    if (!startPos && start >= item.start && start < item.end) startPos = [item.node, start - item.start];
    if (end > item.start && end <= item.end) {
      endPos = [item.node, end - item.start];
      break;
    }
  }
  if (!startPos) return null;
  const range = document.createRange();
  range.setStart(startPos[0], startPos[1]);
  if (endPos) range.setEnd(endPos[0], endPos[1]);
  else range.collapse(true);
  return range;
}

// Short context around a character offset (sidebar and Obsidian export of an EPUB ink note).
export function contextSnippet(rootEl, offset, radius = 48) {
  const text = (rootEl.textContent || '').replace(/\s+/g, ' ');
  const from = Math.max(0, offset - radius);
  const snippet = text.slice(from, Math.min(text.length, offset + radius)).trim();
  return RTL_CHAR_RE.test(snippet) ? normalizePersianText(snippet) : snippet;
}

// One <svg> with every stroke of an ink highlight, for a surface of the given aspect (height / width).
export function buildInkSvg(strokes, aspect, className = 'ink-svg') {
  const W = 1000;
  const H = Math.max(1, Math.round(W * aspect));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  for (const s of strokes) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', strokeOutlinePath(s, W, H));
    path.setAttribute('fill', inkColorHex(s.color));
    svg.appendChild(path);
  }
  return svg;
}

function unwrapEpubHighlights(epubBody) {
  const marks = epubBody.querySelectorAll('mark.epub-hl');
  if (marks.length === 0) return;
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }
  epubBody.normalize();
}

function applyEpubHighlightRange(epubBody, startOffset, endOffset, hl, onClick) {
  const { nodes } = getEpubTextNodes(epubBody);
  const targets = [];

  for (const item of nodes) {
    if (item.end <= startOffset || item.start >= endOffset) continue;
    const localStart = Math.max(0, startOffset - item.start);
    const localEnd = Math.min(item.end - item.start, endOffset - item.start);
    if (localEnd > localStart) {
      targets.push({ node: item.node, localStart, localEnd });
    }
  }

  for (const t of targets) {
    try {
      const range = document.createRange();
      range.setStart(t.node, t.localStart);
      range.setEnd(t.node, t.localEnd);
      const mark = document.createElement('mark');
      mark.className = `epub-hl hl-${hl.color}`;
      mark.dataset.hlId = hl.id;
      mark.title = hl.note ? `یادداشت: ${hl.note}` : 'برای ویرایش یا یادداشت کلیک کنید';
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      range.surroundContents(mark);
    } catch {
      // Skip split across non-text boundary
    }
  }
}

export class AnnotationManager {
  constructor({
    viewportEl,
    selectionToolbarEl,
    onCreateHighlight,
    onOpenHighlightDialog,
    onCopyText,
    onOpenInkCard,
  }) {
    this.viewportEl = viewportEl;
    this.selectionToolbarEl = selectionToolbarEl;
    this.onCreateHighlight = onCreateHighlight;
    this.onOpenHighlightDialog = onOpenHighlightDialog;
    this.onCopyText = onCopyText;
    this.onOpenInkCard = onOpenInkCard;
    this.suppressSelectionUi = false; // true while a pen gesture runs
    this.penOwnsPen = false; // true while the pen controller handles pen input

    this.highlights = [];
    this.bookmarks = [];
    this.areaMode = false;
    this.activeColor = 'amber';
    this.pendingSelection = null;
    this.areaDraft = null;
    this.selectionDebounce = null;

    this.bindEvents();
  }

  setData({ highlights = [], bookmarks = [] }) {
    this.highlights = highlights;
    this.bookmarks = bookmarks;
  }

  setAreaMode(enabled) {
    this.areaMode = Boolean(enabled);
    this.viewportEl.classList.toggle('is-area-mode', this.areaMode);
    if (this.areaMode) {
      this.hideSelectionToolbar();
    }
  }

  bindEvents() {
    const handleSelectionEnd = () => {
      if (this.areaMode) return;
      requestAnimationFrame(() => this.inspectTextSelection());
    };

    this.viewportEl.addEventListener('mouseup', handleSelectionEnd);
    this.viewportEl.addEventListener('keyup', handleSelectionEnd);
    this.viewportEl.addEventListener('touchend', () => {
      if (this.areaMode) return;
      clearTimeout(this.selectionDebounce);
      this.selectionDebounce = setTimeout(() => this.inspectTextSelection(), 260);
    }, { passive: true });

    // Android / touch selection handle adjustment fires selectionchange
    document.addEventListener('selectionchange', () => {
      if (this.areaMode) return;
      if (!window.matchMedia('(pointer: coarse)').matches) return;
      clearTimeout(this.selectionDebounce);
      this.selectionDebounce = setTimeout(() => this.inspectTextSelection(), 320);
    });

    document.addEventListener('pointerdown', (e) => {
      if (!this.selectionToolbarEl.hidden && !this.selectionToolbarEl.contains(e.target)) {
        setTimeout(() => {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed) this.hideSelectionToolbar();
        }, 120);
      }
    });

    // Color swatch click on floating selection toolbar
    this.selectionToolbarEl.querySelectorAll('[data-hl-color]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!this.pendingSelection) return;
        const color = btn.dataset.hlColor;
        const payload = { ...this.pendingSelection, color, note: '' };
        this.hideSelectionToolbar();
        window.getSelection()?.removeAllRanges();
        await this.onCreateHighlight(payload);
      });
    });

    this.selectionToolbarEl.querySelector('#btn-sel-note')?.addEventListener('click', () => {
      if (!this.pendingSelection) return;
      const payload = { ...this.pendingSelection, color: this.activeColor };
      this.hideSelectionToolbar();
      window.getSelection()?.removeAllRanges();
      this.onOpenHighlightDialog({ isNew: true, highlight: payload });
    });

    this.selectionToolbarEl.querySelector('#btn-sel-copy')?.addEventListener('click', async () => {
      if (!this.pendingSelection) return;
      await this.onCopyText(this.pendingSelection.quote_text);
      this.hideSelectionToolbar();
      window.getSelection()?.removeAllRanges();
    });

    // Area Highlight Dragging (for scanned Persian PDFs)
    this.viewportEl.addEventListener('pointerdown', (e) => this.onAreaPointerDown(e));
    this.viewportEl.addEventListener('pointermove', (e) => this.onAreaPointerMove(e));
    this.viewportEl.addEventListener('pointerup', (e) => this.onAreaPointerUp(e));
  }

  positionSelectionToolbar(anchorRect) {
    this.selectionToolbarEl.hidden = false;
    const tbRect = this.selectionToolbarEl.getBoundingClientRect();
    const vv = window.visualViewport;
    const vw = vv ? vv.width : window.innerWidth;
    const vLeft = vv ? vv.offsetLeft : 0;
    const vTop = vv ? vv.offsetTop : 0;

    const left = Math.max(
      vLeft + 12,
      Math.min(vLeft + vw - tbRect.width - 12, anchorRect.left + anchorRect.width / 2 - tbRect.width / 2)
    );
    const top = Math.max(vTop + 58, anchorRect.top - tbRect.height - 10);
    this.selectionToolbarEl.style.left = `${left}px`;
    this.selectionToolbarEl.style.top = `${top}px`;
  }

  inspectTextSelection() {
    if (this.suppressSelectionUi) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.hideSelectionToolbar();
      return;
    }

    const described = this.describeRange(sel.getRangeAt(0));
    if (!described) {
      this.hideSelectionToolbar();
      return;
    }
    this.pendingSelection = described.payload;
    this.positionSelectionToolbar(described.anchorRect);
  }

  // Range -> { payload: { page, kind: 'text', quote_text, rects }, anchorRect }, or null when it holds no text.
  // Shared by the native selection toolbar and pen highlighting.
  describeRange(range) {
    const commonNode = range.commonAncestorContainer;
    const el = commonNode.nodeType === Node.ELEMENT_NODE ? commonNode : commonNode.parentElement;

    // 1. EPUB chapter
    const epubBody = el?.closest('.epub-chapter-body');
    const epubShell = epubBody?.closest('.epub-chapter-shell');
    if (epubBody && epubShell) {
      const rawText = range.toString().replace(/\s+/g, ' ').trim();
      const quoteText = RTL_CHAR_RE.test(rawText) ? normalizePersianText(rawText) : rawText;
      if (!quoteText) return null;
      const start = getOffsetInRoot(epubBody, range.startContainer, range.startOffset);
      const end = getOffsetInRoot(epubBody, range.endContainer, range.endOffset);
      if (start < 0 || end <= start) return null;
      return {
        payload: {
          page: Number(epubShell.dataset.page),
          kind: 'text',
          quote_text: quoteText,
          rects: [{ mode: 'epub-text', start, end }],
        },
        anchorRect: range.getBoundingClientRect(),
      };
    }

    // 2. PDF page
    const shell = el?.closest('.pdf-page-shell');
    if (!shell) return null;

    const quoteText = extractCleanSelectionText(range, shell);
    if (!quoteText) return null;

    const pageRect = shell.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) return null;

    const rawRects = Array.from(range.getClientRects()).filter((r) => r.width > 2 && r.height > 2);
    if (rawRects.length === 0) return null;

    const normalized = rawRects.map((r) => ({
      x: Math.max(0, Math.min(1, (r.left - pageRect.left) / pageRect.width)),
      y: Math.max(0, Math.min(1, (r.top - pageRect.top) / pageRect.height)),
      w: Math.max(0.002, Math.min(1, r.width / pageRect.width)),
      h: Math.max(0.004, Math.min(1, r.height / pageRect.height)),
    }));

    return {
      payload: {
        page: Number(shell.dataset.page),
        kind: 'text',
        quote_text: quoteText,
        rects: normalized,
      },
      anchorRect: rawRects[0],
    };
  }

  hideSelectionToolbar() {
    this.selectionToolbarEl.hidden = true;
    this.pendingSelection = null;
  }

  onAreaPointerDown(e) {
    if (!this.areaMode || e.button !== 0) return;
    if (e.pointerType === 'pen' && this.penOwnsPen) return;
    if (e.pointerType === 'touch' && this.viewportEl.classList.contains('pen-near')) return; // palm
    if (e.target.closest('.hl-rect')) return;
    const shell = e.target.closest('.pdf-page-shell:not(.epub-chapter-shell)');
    if (!shell) return;

    const layer = shell.querySelector('.pdf-annotation-layer');
    if (!layer) return;

    const rect = shell.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startY = e.clientY - rect.top;

    const draftBox = document.createElement('div');
    draftBox.className = 'area-draft-box';
    layer.appendChild(draftBox);

    this.areaDraft = {
      shell,
      pageRect: rect,
      startX,
      startY,
      curX: startX,
      curY: startY,
      draftBox,
    };
    shell.setPointerCapture?.(e.pointerId);
  }

  onAreaPointerMove(e) {
    if (!this.areaDraft) return;
    const { pageRect, startX, startY, draftBox } = this.areaDraft;
    const curX = Math.max(0, Math.min(pageRect.width, e.clientX - pageRect.left));
    const curY = Math.max(0, Math.min(pageRect.height, e.clientY - pageRect.top));
    this.areaDraft.curX = curX;
    this.areaDraft.curY = curY;

    const x = Math.min(startX, curX);
    const y = Math.min(startY, curY);
    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);

    draftBox.style.left = `${x}px`;
    draftBox.style.top = `${y}px`;
    draftBox.style.width = `${w}px`;
    draftBox.style.height = `${h}px`;
  }

  onAreaPointerUp() {
    if (!this.areaDraft) return;
    const { shell, pageRect, startX, startY, curX, curY, draftBox } = this.areaDraft;
    draftBox.remove();
    this.areaDraft = null;

    const w = Math.abs(curX - startX);
    const h = Math.abs(curY - startY);
    if (w < 14 || h < 12) return;

    const normRect = {
      x: Math.min(startX, curX) / pageRect.width,
      y: Math.min(startY, curY) / pageRect.height,
      w: w / pageRect.width,
      h: h / pageRect.height,
    };

    this.onOpenHighlightDialog({
      isNew: true,
      highlight: {
        page: Number(shell.dataset.page),
        kind: 'area',
        color: this.activeColor,
        quote_text: '',
        rects: [normRect],
      },
    });
  }

  // EPUB ink notes sit in the margin as markers: text reflows, so strokes are never drawn over the text.
  renderEpubInkMarkers(shell, epubBody, inkHighlights) {
    shell.querySelectorAll('.ink-marker').forEach((m) => m.remove());
    if (inkHighlights.length === 0) return;
    const shellRect = shell.getBoundingClientRect();
    const total = (epubBody.textContent || '').length;
    const usedTops = [];
    for (const hl of inkHighlights) {
      const anchor = inkAnchor(hl.rects);
      if (!anchor) continue;
      const start = Math.min(anchor.start, Math.max(0, total - 1));
      const range = rangeAtOffsets(epubBody, start, Math.min(total, start + 1));
      const r = range?.getClientRects()[0] || range?.getBoundingClientRect();
      let top = r && r.height > 0 ? r.top - shellRect.top : 8;
      while (usedTops.some((t) => Math.abs(t - top) < 30)) top += 32; // notes anchored to the same line stack
      usedTops.push(top);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ink-marker';
      btn.dataset.hlId = hl.id;
      btn.style.top = `${Math.max(0, top)}px`;
      btn.style.setProperty('--ink-marker-color', inkColorHex(inkStrokes(hl.rects)[0]?.color));
      btn.title = 'یادداشت دست‌نویس (برای دیدن و ویرایش بزنید)';
      btn.setAttribute('aria-label', 'یادداشت دست‌نویس');
      btn.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onOpenInkCard?.({ highlight: hl });
      });
      shell.appendChild(btn);
    }
  }

  renderPageOverlays(pageNum, shell) {
    const pageHighlights = this.highlights.filter((h) => h.page === pageNum);

    if (shell.classList.contains('epub-chapter-shell')) {
      const epubBody = shell.querySelector('.epub-chapter-body');
      if (epubBody) {
        unwrapEpubHighlights(epubBody);
        const fullText = epubBody.textContent || '';
        for (const hl of pageHighlights) {
          if (hl.kind === 'ink') continue;
          const firstRect = hl.rects?.[0];
          let start = typeof firstRect?.start === 'number' ? firstRect.start : -1;
          let end = typeof firstRect?.end === 'number' ? firstRect.end : -1;
          if ((start < 0 || end <= start) && hl.quote_text) {
            const idx = fullText.indexOf(hl.quote_text);
            if (idx !== -1) {
              start = idx;
              end = idx + hl.quote_text.length;
            }
          }
          if (start >= 0 && end > start) {
            applyEpubHighlightRange(epubBody, start, end, hl, () => {
              this.onOpenHighlightDialog({ isNew: false, highlight: hl });
            });
          }
        }
        this.renderEpubInkMarkers(shell, epubBody, pageHighlights.filter((h) => h.kind === 'ink'));
      }
    } else {
      let layer = shell.querySelector('.pdf-annotation-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'pdf-annotation-layer';
        shell.appendChild(layer);
      }
      layer.innerHTML = '';

      const aspect = shell.offsetWidth > 0 ? shell.offsetHeight / shell.offsetWidth : 1.414;
      for (const hl of pageHighlights) {
        if (hl.kind === 'ink') {
          const svg = buildInkSvg(inkStrokes(hl.rects), aspect, 'ink-svg');
          svg.dataset.hlId = hl.id;
          svg.querySelectorAll('path').forEach((p) => {
            p.addEventListener('click', (e) => {
              e.stopPropagation();
              this.onOpenHighlightDialog({ isNew: false, highlight: hl });
            });
          });
          layer.appendChild(svg);
          continue;
        }
        for (const r of hl.rects) {
          if (typeof r.x !== 'number') continue;
          const div = document.createElement('div');
          div.className = `hl-rect hl-${hl.color}${hl.kind === 'area' ? ' is-area' : ''}`;
          div.style.left = `${r.x * 100}%`;
          div.style.top = `${r.y * 100}%`;
          div.style.width = `${r.w * 100}%`;
          div.style.height = `${r.h * 100}%`;
          div.title = hl.note ? `یادداشت: ${hl.note}` : 'برای ویرایش یا یادداشت کلیک کنید';
          div.addEventListener('click', (e) => {
            e.stopPropagation();
            this.onOpenHighlightDialog({ isNew: false, highlight: hl });
          });
          layer.appendChild(div);
        }
      }
    }

    // Physical Bookmark Ribbon on top corner
    shell.querySelector('.page-ribbon')?.remove();
    const pageBookmarks = this.bookmarks.filter((b) => b.page === pageNum);
    if (pageBookmarks.length > 0) {
      const hasPin = pageBookmarks.some((b) => b.kind === 'pin');
      const ribbonColor = hasPin ? '#d97706' : '#dc2626';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'page-ribbon');
      svg.setAttribute('viewBox', '0 0 24 36');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = `<path d="M2 0h20v34l-10-8-10 8V0z" fill="${ribbonColor}"/>`;
      shell.appendChild(svg);
    }
  }
}
