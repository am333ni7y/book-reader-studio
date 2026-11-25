# Milestone Synthesis: v2.0 — Public Release, EPUB Engine & Cross-Platform CLI

- **Milestone**: `M1 — v2.0 Public Release`
- **Date**: 2026-11-25
- **Status**: Completed & Verified

---

## Summary of Deliverables
1. **Zero-Dependency EPUB 2/3 Engine**:
   - `lib/epub-parser.mjs`: Pure Node.js ZIP Central Directory reader + OPF/Spine/Nav/NCX parser, cover extraction, CSS `url()` rewriting, server-side HTML sanitization, and full-book search.
   - `public/js/epub-engine.js`: Lazy `IntersectionObserver` chapter renderer with native `Element.setHTML()` sanitization + fallback, RTL/LTR auto-direction, internal chapter link navigation, and 2-column spread mode.
   - `public/js/annotations.js`: Added reflowable EPUB character-offset highlights (`<mark class="epub-hl">`) and Android touch selection support (`touchend` / `selectionchange` + `visualViewport` clamping).
2. **Bug Fixes**:
   - Fixed `TypeError: this.pdfDoc.destroy is not a function` in `public/js/pdf-engine.js` (`pdfjs-dist@6.5.438` uses `loadingTask.destroy()` / `cleanup()`).
3. **Cross-Platform CLI & Installers (macOS / Windows / Android)**:
   - `bin/ketabkhan.mjs`: `ketabkhan start`, `ketabkhan add <file>`, `ketabkhan seed`, `ketabkhan doctor`, `--lan`, `--open`, `--port`, `--data-dir`, `--notes-dir`.
   - `install.sh` (macOS, Linux, Android Termux + Termux:Widget shortcut), `install.ps1` (Windows 10/11 PowerShell + PATH shim), `start.bat`, `start.sh`.
   - `public/manifest.webmanifest` + locally generated/optimized PWA icons (`public/icons/icon-192.png`, `icon-512.png`).
4. **Bilingual Documentation & Public Repository**:
   - Complete English + Persian (`README.md`, `README.fa.md`), MIT `LICENSE`, `.gitignore`, and `.env` isolation for personal vault paths.
