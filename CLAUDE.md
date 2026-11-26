# CLAUDE.md

## Overview
Ketabkhan Studio (book-reader-studio): Ameeen's own local-first PDF + EPUB reader with RTL/LTR typography, highlights, bookmarks, custom TOC and Obsidian export. Public repo `am333ni7y/book-reader-studio` (MIT). Targets: Node CLI/PWA server, Electron desktop (macOS/Windows), Capacitor Android APK.

## Stack and tools
- Node >= 22.5 (`node:sqlite`; JSON-file fallback store), plain ES modules, no framework. Deps: `pdfjs-dist`, `vazirmatn`. Dev: Electron 45, electron-builder, Capacitor 8.
- pnpm 12.4.2 is the declared package manager; this VM has no pnpm, use `npm install --omit=dev --ignore-scripts --no-package-lock` (never commit a package-lock.json).

## Key paths
- `server.mjs` HTTP API + static server; `lib/db-adapter.mjs` (SQLite + JSON stores); `lib/epub-parser.mjs` (own ZIP/EPUB parser); `bin/ketabkhan.mjs` CLI.
- `public/` SPA; `public/js/client-backend.js` = IndexedDB backend used by the Android APK (no server); `public/js/epub-client.js` = browser twin of the EPUB parser.
- S Pen: `public/js/pen-input.js` (PenController, InkPad), `public/js/ink-core.js` (pure ink model shared by server, stores, IndexedDB, Obsidian export); design in `docs/decisions/0006-s-pen-ink-and-pen-highlighting.md`.
- `electron/` desktop shell (starts the server on 127.0.0.1, random port). `android/` Capacitor project.
- `docs/decisions/`, `docs/failures/`, `docs/milestones/`, `docs/RELEASING.md`.

## How to run / test / release
- `node bin/ketabkhan.mjs start [--lan] [--port N]`; tests: `npm test` (= `node --test tests/*.test.mjs`; a bare `tests/` dir fails on Node 24).
- Pen browser check: `node scripts/pen-check.mjs <outDir> [--mode=server|client|both]` (headless Chrome, synthetic pen via CDP `pointerType: "pen"`, 33 checks, screenshots to outDir).
- Release: push tag `vX.Y.Z` -> `.github/workflows/release-apps.yml` builds APK/EXE/DMG. Android signing needs repo secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (see `docs/RELEASING.md`).

## Decisions
- 2026-11-26: review fixes (branch `fix/review-findings`): stable Android signing key from secrets, Host allow-list + Origin/JSON checks on the API, LAN token cookie, EPUB parser memory/zip-bomb limits, collision-free Obsidian export with user-edit markers.
- 2026-11-26: S Pen (ADR 0006): pen writes / finger scrolls, no mode switch; ink stored as highlight `kind: 'ink'` (`rects` = `[meta, ...strokes]`); highlight kinds whitelisted `text|area|ink`; only ink rects are patchable.

## Status and next steps
- 2026-11-26: v3.0.0 released (APK signed with a throwaway CI key, so the next APK cannot update it). Review fixes in progress on `fix/review-findings`.
- 2026-11-26: permanent Android keystore created (PKCS12 via openssl, alias `ketabkhan`, RSA 4096, valid to 2054, cert SHA256 `9E:51:2B:BB:…:DC:57`). Stored as DPAPI `book-reader-studio-android-keystore-b64`, `-keystore-password`, `-key-password`, `-key-alias` + vault `secrets/book-reader-studio.json`; the 4 GitHub secrets are set.
- 2026-11-26: v3.1.0 released (all 5 assets; APK signed with the permanent key). EPUB parsers unified: shared pure core `public/js/epub-core.js` (ZIP directory, OPF/nav/NCX, sanitizer, CSS scoping, search); `lib/epub-parser.mjs` (fd + zlib) and `public/js/epub-client.js` (Blob + DecompressionStream) are thin adapters. README screenshots in `docs/screenshots/` (Iminify-compressed).
- 2026-11-26: v3.2.0 released with S Pen support (PR #4; all 5 assets). Ameeen skipped the pre-release device test and installs it directly; real Galaxy Ultra checklist at the end of ADR 0006 still open.
- 2026-11-26: optional code signing wired into `release-apps.yml` (ADR 0007, `docs/RELEASING.md` §6): Windows Azure Artifact Signing > PFX > SignPath > unsigned; macOS Developer ID + notarization (API key or Apple ID). Without secrets it builds unsigned as before. No certificate yet: Ameeen must pick a provider and pass identity validation; signed paths are untested until then.
- Open: get a signing provider (SignPath Foundation / Certum for Windows, Apple Developer for macOS); Android client path only tested in Node/desktop browser, not in a real WebView.

## Gotchas
- Three persistence backends (SQLite, JSON, IndexedDB); backup import/matching logic is duplicated in `server.mjs` and `client-backend.js` (keep in sync).
- Client mode (IndexedDB) is chosen when `/api/health` fails; to test it in a desktop browser, serve `public/` statically with `/api/*` returning 404.
- Screenshots: headless Chrome over CDP (script pattern in `hugooptic/design/product/shots/themec/cdp-shot.mjs`), fresh `--user-data-dir`, delete afterwards.
- Page re-layout (viewport ResizeObserver) detaches the page under the pen; it is deferred while `pen.gesture` is set. Do not put pen-toolbar spacing on `.pdf-viewport` (it triggers the observer).
- Electron/desktop data dir differs from CLI data dir (`lib/paths.mjs`).
