# CLAUDE.md

## Overview
Ketabkhan Studio (book-reader-studio): Ameeen's own local-first PDF + EPUB reader with RTL/LTR typography, highlights, bookmarks, custom TOC and Obsidian export. Public repo `am333ni7y/book-reader-studio` (MIT). Targets: Node CLI/PWA server, Electron desktop (macOS/Windows), Capacitor Android APK.

## Stack and tools
- Node >= 22.5 (`node:sqlite`; JSON-file fallback store), plain ES modules, no framework. Deps: `pdfjs-dist`, `vazirmatn`. Dev: Electron 45, electron-builder, Capacitor 8.
- pnpm 12.4.2 is the declared package manager; this VM has no pnpm, use `npm install --omit=dev --ignore-scripts --no-package-lock` (never commit a package-lock.json).

## Key paths
- `server.mjs` HTTP API + static server; `lib/db-adapter.mjs` (SQLite + JSON stores); `lib/epub-parser.mjs` (own ZIP/EPUB parser); `bin/ketabkhan.mjs` CLI.
- `public/` SPA; `public/js/client-backend.js` = IndexedDB backend used by the Android APK (no server); `public/js/epub-client.js` = browser twin of the EPUB parser.
- `electron/` desktop shell (starts the server on 127.0.0.1, random port). `android/` Capacitor project.
- `docs/decisions/`, `docs/failures/`, `docs/milestones/`, `docs/RELEASING.md`.

## How to run / test / release
- `node bin/ketabkhan.mjs start [--lan] [--port N]`; tests: `npm test` (= `node --test tests/*.test.mjs`; a bare `tests/` dir fails on Node 24).
- Release: push tag `vX.Y.Z` -> `.github/workflows/release-apps.yml` builds APK/EXE/DMG. Android signing needs repo secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (see `docs/RELEASING.md`).

## Decisions
- 2026-11-26: review fixes (branch `fix/review-findings`): stable Android signing key from secrets, Host allow-list + Origin/JSON checks on the API, LAN token cookie, EPUB parser memory/zip-bomb limits, collision-free Obsidian export with user-edit markers.

## Status and next steps
- 2026-11-26: v3.0.0 released (APK signed with a throwaway CI key, so the next APK cannot update it). Review fixes in progress on `fix/review-findings`.
- 2026-11-26: permanent Android keystore created (PKCS12 via openssl, alias `ketabkhan`, RSA 4096, valid to 2054, cert SHA256 `9E:51:2B:BB:…:DC:57`). Stored as DPAPI `book-reader-studio-android-keystore-b64`, `-keystore-password`, `-key-password`, `-key-alias` + vault `secrets/book-reader-studio.json`; the 4 GitHub secrets are set.
- Open: unify the two EPUB parsers; code signing for Windows/macOS.

## Gotchas
- Three persistence backends (SQLite, JSON, IndexedDB) and two EPUB parsers must be kept in sync until unified.
- Electron/desktop data dir differs from CLI data dir (`lib/paths.mjs`).
