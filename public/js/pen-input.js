// S Pen / stylus input: pen writes, finger scrolls, no mode switch.
// Pointer Events report the S Pen as pointerType 'pen' with pressure, tiltX/tiltY, hover moves (buttons 0)
// and the side button as buttons & 2 (buttons & 32 = eraser end on pens that have one).
import { normalizePoint, thinPoints, strokeOutlinePath, inkColorHex, INK_WIDTHS, EPUB_CARD_ASPECT, strokesHitBy, inkStrokes } from './ink-core.js';
import { getOffsetInRoot, contextSnippet, buildInkSvg } from './annotations.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PEN_IDLE_MS = 2500; // pen out of hover range for this long -> finger scrolling everywhere again
const ERASER_RADIUS = 0.012; // fraction of the surface width
const PREFS_KEY = 'ketabkhan.pen.prefs';

export const PEN_TOOLS = ['highlight', 'ink', 'eraser'];

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      tool: PEN_TOOLS.includes(raw.tool) ? raw.tool : 'highlight',
      size: ['s', 'm', 'l'].includes(raw.size) ? raw.size : 'm',
      hlColor: raw.hlColor || 'amber',
      inkColor: raw.inkColor || 'black',
    };
  } catch {
    return { tool: 'highlight', size: 'm', hlColor: 'amber', inkColor: 'black' };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // private mode / blocked storage: prefs are a convenience only
  }
}

// Caret (node, offset) under a client point; Chrome 128+ has caretPositionFromPoint, older WebViews the WebKit API.
export function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

function rangeBetween(a, b) {
  if (!a || !b) return null;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(a.node, a.offset);
    const probe = document.createRange();
    probe.setStart(b.node, b.offset);
    probe.collapse(true);
    if (range.compareBoundaryPoints(Range.START_TO_START, probe) <= 0) {
      range.setEnd(b.node, b.offset);
    } else {
      range.setStart(b.node, b.offset);
      range.setEnd(a.node, a.offset);
    }
  } catch {
    return null;
  }
  return range;
}

function pointsFromEvent(e) {
  const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
  return list.length > 0 ? list : [e];
}

// Collects one pressure-sensitive stroke on a surface element and draws it live into an <svg>.
class StrokeRecorder {
  constructor(surfaceEl, { color, width, liveParent }) {
    this.rect = surfaceEl.getBoundingClientRect();
    this.aspect = this.rect.width > 0 ? this.rect.height / this.rect.width : 1;
    this.stroke = { points: [], color, width };
    this.W = 1000;
    this.H = Math.max(1, Math.round(1000 * this.aspect));
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'ink-live');
    this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.path = document.createElementNS(SVG_NS, 'path');
    this.path.setAttribute('fill', inkColorHex(color));
    this.svg.appendChild(this.path);
    (liveParent || surfaceEl).appendChild(this.svg);
    this.raf = 0;
  }

  add(e) {
    for (const ev of pointsFromEvent(e)) {
      this.stroke.points.push(normalizePoint(ev.clientX, ev.clientY, ev.pressure, this.rect));
    }
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.path.setAttribute('d', strokeOutlinePath(this.stroke, this.W, this.H));
      });
    }
  }

  finish() {
    cancelAnimationFrame(this.raf);
    this.svg.remove();
    if (this.stroke.points.length === 0) return null;
    return { ...this.stroke, points: thinPoints(this.stroke.points) };
  }

  cancel() {
    cancelAnimationFrame(this.raf);
    this.svg.remove();
  }
}

export class PenController {
  // hooks: createHighlight(payload), commitPdfStroke(page, stroke, aspect), eraseStrokes(Map<hl, strokes>),
  //        openInkCard({ page, anchor, quote_text }), getHighlights(), onPenDetected(), onToolChange(prefs)
  constructor({ viewportEl, annotations, hooks }) {
    this.viewportEl = viewportEl;
    this.annotations = annotations;
    this.hooks = hooks;
    this.prefs = loadPrefs();
    this.enabled = true;
    this.penDetected = false;
    this.gesture = null;
    this.idleTimer = 0;
    this.suppressClickUntil = 0;
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'pen-preview';
    document.body.appendChild(this.previewEl);
    this.annotations.penOwnsPen = true;
    this.bind();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.annotations.penOwnsPen = this.enabled;
    if (!this.enabled) {
      this.abortGesture();
      this.setPenNear(false);
    }
  }

  setPrefs(patch) {
    this.prefs = { ...this.prefs, ...patch };
    savePrefs(this.prefs);
    this.hooks.onToolChange?.(this.prefs);
  }

  get baseWidth() {
    return INK_WIDTHS[this.prefs.size] || INK_WIDTHS.m;
  }

  setPenNear(near) {
    clearTimeout(this.idleTimer);
    this.viewportEl.classList.toggle('pen-near', near);
    if (near) {
      this.idleTimer = setTimeout(() => {
        if (!this.gesture) this.viewportEl.classList.remove('pen-near');
      }, PEN_IDLE_MS);
    }
  }

  notePen(e) {
    if (!this.penDetected) {
      this.penDetected = true;
      this.hooks.onPenDetected?.();
    }
    if (this.enabled && this.viewportEl.contains(e.target)) this.setPenNear(true);
  }

  bind() {
    const opts = { capture: true };
    // Hover: switch touch-action off before the pen lands (touch-action is fixed at pointerdown).
    document.addEventListener('pointerover', (e) => { if (e.pointerType === 'pen') this.notePen(e); }, opts);
    document.addEventListener('pointermove', (e) => this.onMove(e), opts);
    document.addEventListener('pointerdown', (e) => this.onDown(e), opts);
    document.addEventListener('pointerup', (e) => this.onUp(e), opts);
    document.addEventListener('pointercancel', (e) => this.onCancel(e), opts);
    document.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'pen' && !this.gesture && e.target === document.documentElement) this.setPenNear(false);
    }, opts);
    // A pen stroke must never start a native selection, a long-press menu, or a click on what it ended over.
    document.addEventListener('selectstart', (e) => {
      if (this.gesture || this.viewportEl.classList.contains('pen-near')) e.preventDefault();
    }, opts);
    document.addEventListener('contextmenu', (e) => {
      if (this.gesture || (this.viewportEl.classList.contains('pen-near') && this.viewportEl.contains(e.target))) e.preventDefault();
    }, opts);
    document.addEventListener('click', (e) => {
      if (Date.now() < this.suppressClickUntil && this.viewportEl.contains(e.target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, opts);
  }

  toolFor(e) {
    // Side button held (S Pen barrel button = buttons & 2) or a pen's eraser end (buttons & 32) -> eraser.
    if ((e.buttons & 2) || (e.buttons & 32) || e.button === 5) return 'eraser';
    return this.prefs.tool;
  }

  onDown(e) {
    if (e.pointerType !== 'pen') return;
    this.notePen(e);
    if (!this.enabled || !this.viewportEl.contains(e.target)) return;
    const shell = e.target.closest?.('.pdf-page-shell');
    if (!shell) return;
    if (e.target.closest('.ink-marker')) return; // let the pen open an EPUB ink note

    e.preventDefault();
    e.stopPropagation();
    this.abortGesture();
    this.annotations.suppressSelectionUi = true;
    this.annotations.hideSelectionToolbar();
    this.viewportEl.classList.add('pen-drawing');
    try {
      this.viewportEl.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests may not be capturable
    }

    const isEpub = shell.classList.contains('epub-chapter-shell');
    const tool = this.toolFor(e);
    const g = {
      pointerId: e.pointerId,
      shell,
      isEpub,
      tool,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    if (tool === 'ink' && !isEpub) {
      const layer = shell.querySelector('.pdf-annotation-layer') || shell;
      g.recorder = new StrokeRecorder(shell, { color: this.prefs.inkColor, width: this.baseWidth, liveParent: layer });
      g.recorder.add(e);
    } else if (tool === 'eraser') {
      g.erased = new Map();
      this.eraseAt(g, e);
    } else if (tool === 'highlight') {
      g.startCaret = caretAt(e.clientX, e.clientY);
    }
    this.gesture = g;
  }

  onMove(e) {
    if (e.pointerType !== 'pen') return;
    this.notePen(e);
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 4) g.moved = true;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    // Side button pressed mid-stroke turns the rest of the gesture into erasing.
    if (g.tool !== 'eraser' && ((e.buttons & 2) || (e.buttons & 32))) {
      g.recorder?.cancel();
      g.recorder = null;
      this.clearPreview();
      g.tool = 'eraser';
      g.erased = new Map();
    }
    if (g.tool === 'ink' && g.recorder) g.recorder.add(e);
    else if (g.tool === 'eraser') this.eraseAt(g, e);
    else if (g.tool === 'highlight') this.previewHighlight(g);
  }

  onUp(e) {
    if (e.pointerType !== 'pen') return;
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    this.gesture = null;
    this.endGestureUi();
    if (g.moved || g.tool !== 'highlight') this.suppressClickUntil = Date.now() + 450;

    if (g.tool === 'ink') {
      if (g.isEpub) {
        this.openEpubInkCard(g);
      } else if (g.recorder) {
        const stroke = g.recorder.finish();
        if (stroke) this.hooks.commitPdfStroke(Number(g.shell.dataset.page), stroke, g.recorder.aspect);
      }
    } else if (g.tool === 'eraser') {
      if (g.erased.size > 0) this.hooks.eraseStrokes(g.erased, { final: true });
    } else if (g.tool === 'highlight' && g.moved) {
      this.commitHighlight(g);
    }
  }

  onCancel(e) {
    if (e.pointerType !== 'pen' || !this.gesture || e.pointerId !== this.gesture.pointerId) return;
    this.abortGesture();
  }

  abortGesture() {
    const g = this.gesture;
    if (!g) return;
    g.recorder?.cancel();
    if (g.erased?.size) this.hooks.eraseStrokes(g.erased, { final: true });
    this.gesture = null;
    this.endGestureUi();
  }

  endGestureUi() {
    this.clearPreview();
    this.viewportEl.classList.remove('pen-drawing');
    this.setPenNear(true);
    setTimeout(() => {
      this.annotations.suppressSelectionUi = false;
    }, 350);
  }

  clearPreview() {
    this.previewEl.replaceChildren();
  }

  // ---------- highlight ----------
  highlightRange(g) {
    const rect = g.shell.getBoundingClientRect();
    const x = Math.max(rect.left + 1, Math.min(rect.right - 1, g.lastX));
    const y = Math.max(rect.top + 1, Math.min(rect.bottom - 1, g.lastY));
    const endCaret = caretAt(x, y);
    if (!g.startCaret || !endCaret) return null;
    if (!g.shell.contains(g.startCaret.node) || !g.shell.contains(endCaret.node)) return null;
    const range = rangeBetween(g.startCaret, endCaret);
    return range && !range.collapsed ? range : null;
  }

  pageHasText(shell) {
    const tl = shell.querySelector('.textLayer');
    return Boolean(tl && tl.textContent.trim().length > 0);
  }

  areaBox(g) {
    const rect = g.shell.getBoundingClientRect();
    const x1 = Math.max(rect.left, Math.min(g.startX, g.lastX));
    const x2 = Math.min(rect.right, Math.max(g.startX, g.lastX));
    // A mostly horizontal pen line over a scanned line of text still gets a usable height.
    const minH = Math.max(14, rect.height * 0.018);
    let y1 = Math.max(rect.top, Math.min(g.startY, g.lastY));
    let y2 = Math.min(rect.bottom, Math.max(g.startY, g.lastY));
    if (y2 - y1 < minH) {
      const mid = (y1 + y2) / 2;
      y1 = Math.max(rect.top, mid - minH / 2);
      y2 = Math.min(rect.bottom, mid + minH / 2);
    }
    return { rect, x1, x2, y1, y2 };
  }

  previewHighlight(g) {
    this.clearPreview();
    const range = this.highlightRange(g);
    const rects = range ? Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1) : [];
    const cls = `pen-preview-rect hl-${this.prefs.hlColor}`;
    if (rects.length > 0) {
      for (const r of rects) this.previewEl.appendChild(this.previewBox(r.left, r.top, r.width, r.height, cls));
    } else if (!g.isEpub) {
      const b = this.areaBox(g);
      this.previewEl.appendChild(this.previewBox(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1, `${cls} is-area`));
    }
  }

  previewBox(left, top, width, height, cls) {
    const d = document.createElement('div');
    d.className = cls;
    Object.assign(d.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    return d;
  }

  async commitHighlight(g) {
    const color = this.prefs.hlColor;
    const range = this.highlightRange(g);
    const described = range ? this.annotations.describeRange(range) : null;
    if (described) {
      await this.hooks.createHighlight({ ...described.payload, color, note: '' });
      return;
    }
    if (g.isEpub) return;
    // Scanned page (no text layer text) or a pen drag outside any text: area highlight of the dragged box.
    const b = this.areaBox(g);
    if (b.x2 - b.x1 < 14) return;
    await this.hooks.createHighlight({
      page: Number(g.shell.dataset.page),
      kind: 'area',
      color,
      note: '',
      quote_text: '',
      rects: [{
        x: (b.x1 - b.rect.left) / b.rect.width,
        y: (b.y1 - b.rect.top) / b.rect.height,
        w: (b.x2 - b.x1) / b.rect.width,
        h: (b.y2 - b.y1) / b.rect.height,
      }],
    });
  }

  // ---------- eraser (PDF ink strokes) ----------
  eraseAt(g, e) {
    if (g.isEpub) return; // EPUB ink lives in note cards; erase inside the card
    const rect = g.shell.getBoundingClientRect();
    if (rect.width <= 0) return;
    const page = Number(g.shell.dataset.page);
    const aspect = rect.height / rect.width;
    let changed = false;
    for (const ev of pointsFromEvent(e)) {
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      for (const hl of this.hooks.getHighlights()) {
        if (hl.kind !== 'ink' || hl.page !== page) continue;
        const current = g.erased.get(hl) || inkStrokes(hl.rects);
        const hits = strokesHitBy(current, x, y, ERASER_RADIUS, aspect);
        if (hits.length === 0) continue;
        g.erased.set(hl, current.filter((_, i) => !hits.includes(i)));
        changed = true;
      }
    }
    if (changed) this.hooks.eraseStrokes(g.erased, { final: false });
  }

  // ---------- EPUB ink note card ----------
  openEpubInkCard(g) {
    const body = g.shell.querySelector('.epub-chapter-body');
    if (!body) return;
    const caret = caretAt(g.startX, g.startY);
    let start = caret && body.contains(caret.node) ? getOffsetInRoot(body, caret.node, caret.offset) : -1;
    if (start < 0) start = 0;
    this.hooks.openInkCard({
      page: Number(g.shell.dataset.page),
      anchor: { mode: 'epub-anchor', start, end: start, aspect: EPUB_CARD_ASPECT },
      quote_text: contextSnippet(body, start),
    });
  }
}

// Drawing pad for the EPUB handwritten note card (pen, mouse, and finger when no pen has been seen).
export class InkPad {
  constructor(surfaceEl, { getStyle, isPenOnly, onChange }) {
    this.surfaceEl = surfaceEl;
    this.getStyle = getStyle;
    this.isPenOnly = isPenOnly;
    this.onChange = onChange;
    this.strokes = [];
    this.eraser = false;
    this.recorder = null;
    this.pointerId = null;
    surfaceEl.addEventListener('pointerdown', (e) => this.down(e));
    surfaceEl.addEventListener('pointermove', (e) => this.move(e));
    surfaceEl.addEventListener('pointerup', (e) => this.up(e));
    surfaceEl.addEventListener('pointercancel', () => this.cancel());
  }

  load(strokes) {
    this.strokes = strokes.map((s) => ({ ...s, points: s.points.map((p) => [...p]) }));
    this.render();
  }

  accepts(e) {
    if (e.pointerType === 'touch' && this.isPenOnly()) return false; // palm while writing with the pen
    return true;
  }

  down(e) {
    if (!this.accepts(e) || this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    try {
      this.surfaceEl.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (this.eraser || (e.buttons & 2) || (e.buttons & 32)) {
      this.erasing = true;
      this.eraseAt(e);
      return;
    }
    const { color, width } = this.getStyle();
    this.recorder = new StrokeRecorder(this.surfaceEl, { color, width });
    this.recorder.add(e);
  }

  move(e) {
    if (e.pointerId !== this.pointerId) return;
    e.preventDefault();
    if (this.erasing) this.eraseAt(e);
    else this.recorder?.add(e);
  }

  up(e) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    if (this.erasing) {
      this.erasing = false;
      return;
    }
    const stroke = this.recorder?.finish();
    this.recorder = null;
    if (stroke) {
      this.strokes.push(stroke);
      this.render();
      this.onChange?.();
    }
  }

  cancel() {
    this.recorder?.cancel();
    this.recorder = null;
    this.pointerId = null;
    this.erasing = false;
  }

  eraseAt(e) {
    const rect = this.surfaceEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    let changed = false;
    for (const ev of pointsFromEvent(e)) {
      const hits = strokesHitBy(this.strokes, (ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height, ERASER_RADIUS * 2, rect.height / rect.width);
      if (hits.length) {
        this.strokes = this.strokes.filter((_, i) => !hits.includes(i));
        changed = true;
      }
    }
    if (changed) {
      this.render();
      this.onChange?.();
    }
  }

  undo() {
    this.strokes.pop();
    this.render();
    this.onChange?.();
  }

  render() {
    this.surfaceEl.querySelector('.ink-svg')?.remove();
    const rect = this.surfaceEl.getBoundingClientRect();
    const aspect = rect.width > 0 ? rect.height / rect.width : EPUB_CARD_ASPECT;
    this.surfaceEl.appendChild(buildInkSvg(this.strokes, aspect, 'ink-svg'));
  }
}
