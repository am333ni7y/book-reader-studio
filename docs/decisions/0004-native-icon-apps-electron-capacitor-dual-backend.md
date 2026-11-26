# ADR 0004: Native Icon-Launchable Apps (Electron Desktop + Capacitor Android + Dual-Backend)

- **Status:** Accepted
- **Date:** 2026-11-26
- **Scope:** Desktop (`macOS .app/.dmg`, `Windows Setup/Portable .exe`) and Mobile (`Android .apk`)

## Context
Users requested true **icon-launchable JavaScript applications** on **macOS**, **Windows**, and **Android** so nobody needs to open a terminal, install Node.js/Termux, or type CLI commands.

## Decision
1. **Desktop (macOS & Windows) via Electron + `electron-builder`**:
   - Embeds the existing Node.js HTTP backend (`server.mjs`) on `127.0.0.1:0` (ephemeral free port) inside `electron/main.mjs` and opens a native `BrowserWindow`.
   - `lib/db-adapter.mjs` dynamically imports `node:sqlite` when available and falls back to an atomic write-through JSON store (`library.json`) if the Electron runtime omits `node:sqlite`.
   - Preload bridge (`electron/preload.cjs`) exposes native OS file picking (`dialog.showOpenDialog`), file associations (`.pdf`, `.epub`), and `Cmd/Ctrl+O`.
   - Static vendor assets (`pdfjs-dist` minified runtime + `vazirmatn`) are bundled into `dist-web/` via `scripts/build-web.mjs` so `node_modules` does not need to be packaged inside the desktop app.

2. **Android (`.apk`) via Capacitor + Pure Client-Side Offline Engine**:
   - Running a Node.js child process inside an Android APK would bloat the APK by 60+ MB and require JNI native binaries per ABI.
   - Instead, `public/js/api.js` probes `/api/health` (skipped immediately in Capacitor WebView) and routes seamlessly to `public/js/client-backend.js`:
     - Stores books, binary `Blob`s, bookmarks, highlights, and custom TOC in **IndexedDB** (`ketabkhan_studio_db`).
     - Renders PDFs directly from `Uint8Array` via `pdfjs-dist` and parses EPUB 2/3 archives purely in browser JS (`public/js/epub-client.js`) using `DataView` and native `DecompressionStream('deflate-raw')`.
     - Exports Obsidian Markdown via Android's native `navigator.share({ files })` sheet or Blob download.

## Consequences
- **Zero-code UX:** Double-click / tap the app icon on all 3 platforms.
- **Single codebase:** Frontend UI, PDF engine, EPUB engine, and highlight/bookmark logic are 100% shared across macOS, Windows, Android, and the CLI server.
- **Automated CI Releases:** `.github/workflows/release-apps.yml` builds signed Android `.apk`, Windows `.exe`, and macOS `.dmg` installers on every `v*` tag.
