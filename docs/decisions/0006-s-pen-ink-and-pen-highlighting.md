# ADR 0006: S Pen Support (Pen Highlighting and Handwritten Ink)

- **Status:** Accepted
- **Date:** 2026-11-26
- **Scope:** `public/js/pen-input.js`, `public/js/ink-core.js`, `public/js/annotations.js`, `public/js/app.js`, `server.mjs`, `lib/db-adapter.mjs`, `public/js/client-backend.js`, `public/js/obsidian-markdown.js`
- **Related:** ADR 0002 (normalized dual-mode PDF annotations), ADR 0004 (Capacitor dual backend)

## Context
Ameeen reads on a Samsung Galaxy Ultra with an S Pen. The Android app is a Capacitor WebView, so the S Pen arrives as Pointer Events (`pointerType: "pen"`, `pressure`, `tiltX/tiltY`, hover moves with `buttons === 0`, side button in `buttons & 2`). Before this change the pen behaved like a finger: it scrolled the page and could only highlight through the long-press selection handles.

## Decision

### Input model: pen writes, finger scrolls, no mode switch
- `PenController` listens in the capture phase on `document` and only acts on `pointerType === "pen"`. Finger and mouse input keep their old behaviour.
- `touch-action` is fixed when a pointer goes down, so the controller adds `.pen-near` (CSS `touch-action: none` on the page) as soon as the pen **hovers**, and removes it 2.5 s after the last pen event or when the pen leaves.
- While the pen is near, touch input does not start area highlights (palm rejection); `selectstart` and `contextmenu` are cancelled during a pen gesture; a click fired at the end of a pen stroke is swallowed.
- Pointer capture on the viewport and `getCoalescedEvents()` give smooth strokes. The viewport ResizeObserver does not rebuild pages while a pen gesture is running (a rebuild detached the page under the pen in testing).

### Tools
- **Highlight** (default): a pen drag builds a DOM Range between `caretPositionFromPoint` (fallback `caretRangeFromPoint`) at pen-down and pen-up, snaps it to whole words, and reuses `AnnotationManager.describeRange()`, the same code the selection toolbar uses. EPUB gets the existing character-offset `epub-text` highlight; PDF gets text-layer rects. On a PDF page without a text layer (scanned) the dragged box becomes an `area` highlight.
- **Ink**: on PDF, strokes are drawn on the page overlay, normalized to the page (x, y in 0..1). On EPUB the text reflows, so ink is never drawn over text: a pen tap opens a handwritten **note card** anchored to the character offset under the pen; the note shows as a margin marker and in the sidebar with a thumbnail.
- **Eraser**: the eraser tool, or holding the S Pen side button (`buttons & 2`; `buttons & 32` for pens with an eraser end), removes whole strokes it touches.
- Sizes S/M/L (`INK_WIDTHS`, thousandths of the surface width), modulated by pressure (`0.4 + pressure`). Highlight colours: the existing 5. Ink colours: black, blue, red.
- A floating RTL toolbar with Persian labels and 48 px targets appears when a pen is first seen; ✕ turns pen handling off, the pen button in the reader toolbar turns it back on.

### Storage: a highlight with `kind: 'ink'`
- `rects` holds the strokes: `[meta, stroke, ...]` where `meta` is `{ mode: 'page', aspect }` (PDF) or `{ mode: 'epub-anchor', start, end, aspect }` (EPUB card), and `stroke = { points: [[x, y, pressure], ...], color, width }`.
- One shared pure module, `public/js/ink-core.js`, validates ink everywhere (server, SQLite and JSON stores, IndexedDB backend, backup import): coordinates clamped and rounded to 4 decimals, colours whitelisted, limits of 400 strokes, 4,000 points per stroke and 60,000 points per note.
- The highlight kind is a whitelist `text | area | ink`. Only ink rects can be changed after creation (`PATCH rects`), so strokes can be appended and erased; text and area ranges stay fixed.
- PDF strokes on the same page within 3 minutes form one ink note. Saves are debounced and serialized so a stroke never races the create of its note.
- Obsidian export writes each ink note as an inline SVG (PDF ink cropped to what was written) plus a text line, so the note stays findable where SVG does not render.

## Consequences
- No schema migration: `kind` was already a free TEXT column; old builds read ink rows as unknown highlights and skip drawing them.
- Backups made by this version contain ink rows. Older versions import them as `text` highlights with stroke rects that they cannot draw (harmless, no crash).
- Checked with synthetic pen input over CDP (`scripts/pen-check.mjs`, server and IndexedDB modes, 33 checks), not yet on a real Galaxy device.

## Needs a real Galaxy Ultra
1. Hover detection: the S Pen must produce hover `pointermove` events in the Capacitor WebView so `.pen-near` is set before the tip lands; if a stroke still scrolls the page, the pen landed without hover.
2. Side button: confirm the WebView reports it as `buttons & 2` while touching. Samsung may use the button for Air Command when pressed while hovering.
3. Palm rejection while writing with the hand resting on the screen; finger scrolling right after the pen leaves (2.5 s idle timeout).
4. Pressure range and latency of the live stroke; whether `getCoalescedEvents()` returns extra points on device.
5. Highlighting Persian EPUB text and PDF text layers with the pen (caret hit-testing on Samsung's WebView version).
6. The ink card on a small screen with the keyboard closed, and its markers after rotating the device.
7. Backup export from the APK and import on desktop with ink notes.
