# ADR 0007: Optional Code Signing for Windows and macOS Builds

- **Status:** Accepted
- **Date:** 2026-11-26
- **Scope:** Release workflow (`.github/workflows/release-apps.yml`), `electron-builder.yml`, `build/entitlements.mac.plist`, `docs/RELEASING.md`
- **Related:** ADR 0004 (native icon apps), ADR 0005 (stable Android signing key), `docs/RELEASING.md`

## Context
The Windows and macOS installers are unsigned. Windows SmartScreen and macOS Gatekeeper warn users, and on recent macOS versions the workaround is awkward. The maintainer is an individual and has not bought a certificate yet. Providers differ in cost, country availability, and whether the private key can be exported, so the project cannot commit to one of them now.

Android is different (ADR 0005): a missing key must fail the job, because a throwaway key breaks updates. For Windows and macOS an unsigned build is still useful, and failing every release for lack of a certificate would block users.

## Decision

### 1. Signing is optional and secret-driven
- When signing secrets exist, CI signs (and notarizes on macOS). When they do not, CI builds unsigned exactly as before and succeeds.
- GitHub `if:` cannot read secrets, so each job has a shell step that computes the mode from the environment and writes it to `$GITHUB_OUTPUT`. Later steps use `steps.sign.outputs.mode`.
- Each job prints a `::notice::` with the mode. A partly configured mode prints a `::warning::` and is ignored (it never half-signs).

### 2. Windows: four mutually exclusive modes
Precedence: Azure Artifact Signing, PFX, SignPath, unsigned.
- **Azure Artifact Signing** through `win.azureSignOptions`, passed as CLI overrides from a bash array so values with spaces are safe.
- **PFX** through `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, handled natively by electron-builder.
- **SignPath** (free for open source through SignPath Foundation): build unsigned, upload the staged `.exe` files, submit a signing request with `signpath/github-action-submit-signing-request@v1`, stage the signed files.
- **Unsigned:** `CSC_IDENTITY_AUTO_DISCOVERY=false`, no signing variables.
- Irrelevant signing variables are unset before the build, so only one mode is active.
- The build step now runs `pnpm build:web` and `pnpm exec electron-builder --win nsis portable --publish never` directly, so CLI overrides work.
- Signed modes end with a verification step: `Get-AuthenticodeSignature` on each staged `.exe` must be `Valid`, otherwise the job fails.

### 3. macOS: signed and notarized, signed only, unsigned
- Signing from `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (exported as `CSC_LINK` and `CSC_KEY_PASSWORD`).
- Notarization only when signing: App Store Connect API key (preferred) or Apple ID. Without credentials the build passes `-c.mac.notarize=false`.
- `electron-builder.yml`: `hardenedRuntime: true`, `gatekeeperAssess: false`, and entitlements from `build/entitlements.mac.plist` (`allow-jit`, `allow-unsigned-executable-memory`). `disable-library-validation` is not added: the app has no third-party native modules (`node:sqlite` is built in).
- Signed builds are verified with `codesign --verify --deep --strict`. Notarized builds also run `xcrun stapler validate` and `spctl -a -t exec -vv`. electron-builder staples the app, not the DMG file, so the DMG check is a warning and the app inside the DMG is validated.
- The decoded App Store Connect key file is deleted in an `if: always()` step.

### 4. Local builds
`pnpm build:win` and `pnpm build:mac` stay unchanged and unsigned by default (no certificate on a developer machine).

## Alternatives considered
- **Require signing in CI (like Android):** blocks releases until a certificate exists. Rejected.
- **One provider only:** none is certain to accept the owner (country, applicant type, key export rules). Rejected.
- **Sign on a separate runner with self-hosted tools:** more moving parts and secrets for no benefit. Rejected.

## Consequences
- Releases keep working today with no secrets. Signing turns on when the owner adds secrets; no workflow edit is needed.
- Identity validation and payment are the owner's to do. Provider notes and secret-creation commands are in `docs/RELEASING.md` section 6.
- The signed paths were written without running electron-builder or the workflow locally. The first signed release must be checked in the job logs.
- SignPath mode signs only the outer installer and portable files, not the files inside them.
- Windows signing options depend on electron-builder 26 option names (`win.azureSignOptions`); an electron-builder upgrade can require updating the overrides.
