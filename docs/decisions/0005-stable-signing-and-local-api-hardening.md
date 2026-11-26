# ADR 0005: Stable Android Signing Key and Local API Hardening

- **Status:** Accepted
- **Date:** 2026-11-26
- **Scope:** Release signing (`.github/workflows/release-apps.yml`, `android/app/build.gradle`), local HTTP API (`server.mjs`), EPUB parser (`lib/epub-parser.mjs`)
- **Related:** ADR 0004 (native icon apps), `docs/RELEASING.md`

## Context
Review of the `fix/review-findings` branch found four problems:

1. **Android signing.** The release workflow generated a new keystore on every CI run with a hard-coded password. Each APK was signed by a different key, so Android refused to update an installed app. Users had to uninstall, which deleted their highlights and bookmarks. v3.0.0 shipped with this throwaway key.
2. **Local API exposure.** The local server accepted any `Host` header, which allows DNS rebinding. It accepted cross-site form posts, which allows CSRF against state-changing endpoints. LAN mode had no access control.
3. **EPUB parsing.** The parser did not bound memory use or the decompressed size of ZIP entries, so a crafted EPUB could exhaust memory (zip bomb).
4. **Obsidian export.** Repeated exports could overwrite notes that the user had edited.

## Decision

### 1. Stable signing key from repository secrets
- The release keystore is created once (see `docs/RELEASING.md`) and stored as the base64 secret `ANDROID_KEYSTORE_BASE64`. Passwords and alias are stored as `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- The workflow decodes the keystore into `android/app/release-key.keystore`, passes the secrets to Gradle through the existing `KETABKHAN_*` variables, and deletes the decoded file in an `if: always()` step.
- If any secret is empty, the job fails with `::error::`. There is no fallback to a generated or debug key for release builds.
- No passwords appear in the repository.

### 2. Local API hardening
- **Host allow-list** against DNS rebinding: requests whose `Host` header is not a configured local name or address are rejected.
- **Origin check and JSON content type** against CSRF: state-changing requests must send an allowed `Origin` (or none, for same-origin tools) and `Content-Type: application/json`.
- **LAN token**: `--lan` requires a token. The token comes from `KETABKHAN_TOKEN` or is generated at start and printed as `?token=...`. Opening that URL once sets an HTTP-only cookie that authorizes later requests.

### 3. EPUB parser limits
- Caps on total archive size, number of entries, and decompressed size per entry and in total. Inputs over a limit are rejected with a clear error instead of consuming memory.

### 4. Obsidian export
- Exports never overwrite an existing note silently. Name collisions are resolved, and notes with user edits are kept (edit markers).

## Consequences
- Future Android releases can update v3.0.0 only after the one-time migration described in the README (export notes, uninstall, install). After that, updates are seamless for all versions signed with the stable key.
- Losing the keystore or its passwords permanently blocks updates. The backup rules in `docs/RELEASING.md` are mandatory.
- LAN users must open the token URL once per device. Scripts that used the bare LAN URL must add the token.
- Browser clients on other origins can no longer call the local API.
