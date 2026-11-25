# Decision Record: Zero-Dependency EPUB Engine & Cross-Platform CLI

- **Decision ID**: `ADR-20261125-03`
- **Status**: Accepted
- **Date**: 2026-11-25
- **Author(s)**: Ameeen / Antigravity
- **Supersedes / Superseded By**: Extends `ADR-20261125-01`

---

## 1. Problem & Context
Ketabkhan Studio v1.0 supported only PDF books and ran via a macOS-oriented `start.sh` with a hardcoded local notes path. To publish the project as a public open-source repository supporting **macOS**, **Windows**, and **Android**, we needed:
1. Full **EPUB 2/3** reading support (RTL/LTR, TOC, assets, highlights, bookmarks, search, Obsidian export).
2. One-line **CLI installation** (`ketabkhan`) across macOS/Linux (`install.sh`), Windows (`install.ps1`), and Android (`Termux` + `LAN PWA`).
3. Zero hardcoded personal paths in tracked source files.

---

## 2. Alternatives Considered

### Option A: Bundle `epubjs` + `jszip` in the browser
- **Pros / Advantages**: Familiar client-side EPUB API.
- **Cons / Disadvantages**: `epubjs@0.3.93` pulls legacy dependencies (`@xmldom/xmldom`, `core-js`, `lodash`, `jszip@3.7.1`, `readable-stream`), renders inside sandboxed `<iframe>`s that complicate unified highlighting/theming/touch selection on Android, and requires downloading the entire EPUB archive to the browser before rendering Chapter 1.
- **Rejection Reason**: Heavy legacy dependency tree and iframe friction for RTL/LTR + touch highlights.

### Option B: Package as Electron / Capacitor native binaries
- **Pros / Advantages**: Standalone `.dmg` / `.exe` / `.apk` binaries.
- **Cons / Disadvantages**: 150MB+ installer downloads, code-signing requirements on macOS/Windows, and separate build pipelines.
- **Rejection Reason**: The user explicitly requested a lightweight **CLI installer** (`فایل نصبی از طریق کامندلاین`) running on macOS, Windows, and Android.

---

## 3. Selected Approach: Pure Node.js `zlib` EPUB Parser + Unified DOM Engine + Cross-Platform CLI & PWA

### 3.1 Why this approach was selected
- **Server-side ZIP + OPF/Nav/NCX Parser (`lib/epub-parser.mjs`)**: Uses Node's built-in `node:zlib` (`inflateRawSync`) and Central Directory + Local File Header parsing (immune to bit-3 data descriptors) with zero external npm dependencies. Chapters and assets (`/api/books/:id/epub-chapter/:num`, `/api/books/:id/epub-asset/*`) stream lazily on demand.
- **Unified Frontend `EpubEngine` (`public/js/epub-engine.js`)**: Uses the native Sanitizer API (`Element.setHTML()`) with a strict allowlist fallback, shares the 4 reading themes (`paper`, `sepia`, `smart-dark`, `midnight`), and supports reflowable character-offset highlights (`mark.epub-hl`) and Android touch selection (`touchend` + `selectionchange`).
- **Dual Android Strategy**: Native execution inside **Termux** (`pkg install nodejs git`) + **LAN PWA** (`ketabkhan --lan` + `manifest.webmanifest`) for zero-install reading from any Android browser.

---

## 4. Trade-Offs Accepted
- **What did we gain?**: Zero new npm dependencies, instant chapter-by-chapter loading even for large EPUBs, unified theming/highlighting across PDF and EPUB, and single-command installation on macOS, Windows, and Android.
- **What did we give up?**: DRM-encrypted EPUBs (e.g., Adobe ADEPT) are not supported; only standard DRM-free EPUB 2/3 archives are supported.
- **Privacy Hygiene**: Moved personal `OBSIDIAN_NOTES_DIR` override to gitignored `.env` (`lib/paths.mjs` defaults to `~/Documents/Ketabkhan-Notes`).
