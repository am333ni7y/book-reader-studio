# Milestone M2: Ketabkhan Studio v3.0 — Native Icon-Launchable Apps (macOS, Windows, Android)

- **Date:** 2026-11-26
- **Version:** `3.0.0`

## What Was Built
1. **Resilient Storage & Static Web Bundler**:
   - `lib/db-adapter.mjs` (`node:sqlite` with atomic `library.json` fallback)
   - `scripts/build-web.mjs` (`dist-web/` bundling `public/`, minified `pdfjs-dist`, and `vazirmatn`)
2. **Pure Client-Side Offline Engine (`Android APK`)**:
   - `public/js/epub-client.js` (browser-native ZIP + `DecompressionStream('deflate-raw')` EPUB 2/3 parser + built-in sample EPUB generator)
   - `public/js/client-backend.js` (IndexedDB storage + `navigator.share` Obsidian export)
   - `public/js/api.js` (automatic HTTP / IndexedDB dual-backend router)
3. **Electron Desktop App (`macOS` & `Windows`)**:
   - `electron/main.mjs`, `electron/preload.cjs`, `electron-builder.yml`
   - Native file picker, OS `.pdf`/`.epub` file associations, ephemeral loopback port, local `/Applications/Ketabkhan Studio.app`
4. **Capacitor Android Native Project**:
   - `capacitor.config.json`, `android/` with custom launcher icons, Persian/English app names, and release signing configuration
5. **CI/CD Multi-Platform Release Pipeline**:
   - `.github/workflows/release-apps.yml` building `.apk`, `.exe`, and `.dmg` on GitHub Releases
