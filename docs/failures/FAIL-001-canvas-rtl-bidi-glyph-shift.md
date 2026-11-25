# Failure & Lesson Record: PDF Canvas RTL Glyph Shift & BiDi Decoding

- **Failure ID**: `FAIL-20261125-01`
- **Date**: 2026-11-25
- **Component**: `public/js/pdf-engine.js`, `public/styles/main.css`, `public/js/bilingual-text.js`, `public/js/app.js`

## 1. Observed Symptoms
1. Opening `Additive Manufacturing Essentials` (Page 15) produced severely corrupted glyph spacing/kerning on `<canvas>` (`trad itiona l w eld ing`, `13 •TheTBGA AM M aturityM odel`).
2. `Vazirmatn-FD-font-face.css` replaced ASCII digits inside English chapter headings (`Chapter 1` -> `Chapter ۱`).
3. Persian PDFs encoded with Arabic Presentation Forms (`U+FB50–U+FEFF`) produced reversed character sequences in naive `TextContent` extraction.
4. Clicking Back (`#btn-back-library`) was unusable because `shell.scrollIntoView()` scrolled the outer `<body>` and pushed `.reader-topbar` off-screen, and no `history.pushState`/`popstate` routing existed.

## 2. Root Cause
- HTML5 `<canvas>` inherits `direction: rtl` from `<html dir="rtl">`. Because `CanvasRenderingContext2D` defaults to `direction = 'inherit'` and `textAlign = 'start'`, `pdf.js` `ctx.fillText()` anchored every glyph from its right edge instead of its left edge, shifting glyphs by their individual widths.
- `pdfjs-dist@6.5.438/build/pdf.mjs` used `Map.prototype.getOrInsertComputed` without legacy polyfills and lacked `wasmUrl`/`iccUrl`.
- `Vazirmatn-FD` applies Farsi-Digits globally to all Latin/ASCII numbers.
- `.reader-view` was not fixed-viewport (`position: fixed; inset: 0`), allowing `scrollIntoView` to scroll the outer document.

## 3. Resolution
1. Isolated `.pdf-page-shell`, `<canvas>`, and `.textLayer` to `direction: ltr !important; unicode-bidi: isolate;` and set `ctx.direction = 'ltr'; ctx.textAlign = 'left';` in `pdf-engine.js`.
2. Switched to `pdfjs-dist/legacy/build/pdf.mjs` + `legacy/build/pdf.worker.mjs` with `wasmUrl` and `iccUrl`.
3. Switched UI font to standard `Vazirmatn-font-face.css` and created `public/js/bilingual-text.js` for NFKC Presentation-Form normalization and spatial RTL/LTR line reconstruction, plus visual-order RTL bracket mirroring (`(`↔`)`, `«`↔`»`) so `(سهامی خاص)` decodes cleanly without inverted parentheses.
4. Made `.reader-view` fixed full-viewport, replaced `scrollIntoView()` with `viewportEl.scrollTo()`, and implemented synchronous `backToLibrary()` + `history.pushState`/`popstate` routing with `inert` view isolation, `document.title` sync, focus restoration, and root-entry synthesis for direct `/book/:id` deep links.
