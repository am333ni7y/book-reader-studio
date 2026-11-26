# Releasing Ketabkhan Studio

This document covers the Android signing key, optional Windows/macOS code signing, and the tag-based release flow. The workflow is `.github/workflows/release-apps.yml`.

## 1. One-time: create the Android release keystore

Android only updates an installed app when the new APK is signed with the same key as the old one. Create the key once, keep it forever, and never regenerate it.

Run this on a trusted machine, outside the repository:

```bash
keytool -genkeypair -v \
  -keystore /secure/path/ketabkhan-release.keystore \
  -storetype PKCS12 \
  -alias ketabkhan \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -dname "CN=<Your Name or Org>, O=<Organization>, C=<Country code>"
```

`keytool` asks for the keystore password and the key password. Choose strong values and record them (see section 4).

## 2. Store the keystore as a GitHub secret

Encode the keystore file as base64.

macOS:
```bash
base64 -i /secure/path/ketabkhan-release.keystore -o /secure/path/ketabkhan-release.keystore.b64
```

Linux:
```bash
base64 -w 0 /secure/path/ketabkhan-release.keystore > /secure/path/ketabkhan-release.keystore.b64
```

Windows PowerShell:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\path\ketabkhan-release.keystore")) | Out-File -NoNewline -Encoding ascii "C:\secure\path\ketabkhan-release.keystore.b64"
```

Upload it (run from the repository folder, with `gh` logged in to the repository owner account):

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < /secure/path/ketabkhan-release.keystore.b64
```

PowerShell does not support `<` redirection, so use:
```powershell
Get-Content -Raw "C:\secure\path\ketabkhan-release.keystore.b64" | gh secret set ANDROID_KEYSTORE_BASE64
```

Then delete the `.b64` file. It is a full copy of the key.

## 3. Store the three passwords as secrets

Each command prompts for the value, so it does not end up in shell history:

```bash
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS        # enter: ketabkhan
gh secret set ANDROID_KEY_PASSWORD
```

The release job fails with a clear `::error::` if any of the four secrets is empty. It never falls back to a throwaway key.

## 4. Back up the keystore (critical)

- If the keystore is lost, or its passwords are lost, **no user can ever update the Android app again**. They would have to uninstall it and lose their data.
- Keep at least two copies of the `.keystore` file, one of them offline (for example an encrypted drive).
- Keep the keystore and its passwords in the password manager and the private secret vault. Do not commit the keystore or the passwords to any repository.
- Do not regenerate the key to "fix" a problem. Rotating it breaks updates for every existing install.

## 5. Release flow

1. Update `versionName` and `versionCode` in `android/app/build.gradle` (and the version in `package.json` if it is used for the desktop builds).
2. Commit and push to the default branch through a pull request.
3. Create and push an annotated tag in the form `vX.Y.Z`:
   ```bash
   git tag -a vX.Y.Z -m "Ketabkhan Studio X.Y.Z"
   git push origin vX.Y.Z
   ```
4. The workflow builds the Android APK, Windows installers and macOS DMGs, then publishes a GitHub Release with all artifacts.

Rules:
- Never move or re-push an existing tag. Users and release notes refer to it. If a tag is wrong, publish a new version number.
- `workflow_dispatch` runs build artifacts only. The GitHub Release job runs only for `v*` tags.
- `versionCode` must increase with every Android release.

## 6. Code signing (optional)

Signing the Windows and macOS builds is optional. If no signing secrets exist, the workflow builds unsigned installers exactly as before and still succeeds. Each job prints a `::notice::` line with the mode it used (see the annotations of the run). If a mode is only partly configured (some of its secrets missing), the job prints a `::warning::` and ignores that mode.

Identity validation, certificate purchase, and any fees are the repository owner's to do. This repository cannot do them for you. Some providers do not serve every country or applicant type, so check eligibility on the provider's own page before you apply. Never commit certificates, keys, or passwords. Keep them in the password manager and the private secret vault, like the Android keystore.

Set secrets with `gh secret set NAME` (prompts for the value) or `gh secret set NAME < file`. In PowerShell use `Get-Content -Raw file | gh secret set NAME`.

### 6.1 Windows modes

The mode is chosen by which secrets are non-empty. Precedence: Azure, then PFX, then SignPath, then unsigned. After a signed build the job runs `Get-AuthenticodeSignature` on every staged `.exe` and fails unless the status is `Valid`.

| Mode | Secrets (all required for that mode) | What happens |
|---|---|---|
| 1. Azure Artifact Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `AZURE_SIGN_PUBLISHER` | electron-builder signs through `win.azureSignOptions` (values passed as CLI overrides). |
| 2. PFX / P12 file | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | electron-builder signs with the exportable certificate. |
| 3. SignPath | `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_POLICY_SLUG`; optional `SIGNPATH_ARTIFACT_CONFIG_SLUG` | CI builds unsigned, uploads the two `.exe` files, SignPath signs them, CI stages the signed copies. |
| 4. Unsigned | none | Same as before. |

**Azure values.** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` come from an Entra ID app registration (service principal) that has the certificate profile signer role (named "Artifact Signing Certificate Profile Signer", earlier "Trusted Signing Certificate Profile Signer") on your signing account. `AZURE_SIGN_ENDPOINT` is the regional endpoint of the account (for example `https://eus.codesigning.azure.net`), `AZURE_SIGN_ACCOUNT` the account name, `AZURE_SIGN_PROFILE` the certificate profile name, and `AZURE_SIGN_PUBLISHER` the exact subject name (CN) of the certificate from your validated identity. Check the exact role and endpoint names in the Azure portal.

**PFX value.** Create the base64 text of the `.pfx` file, then store it.

macOS:
```bash
base64 -i /secure/path/win-cert.pfx | tr -d '\n' > /secure/path/win-cert.pfx.b64
```

Linux:
```bash
base64 -w 0 /secure/path/win-cert.pfx > /secure/path/win-cert.pfx.b64
```

Windows PowerShell:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\path\win-cert.pfx")) | Out-File -NoNewline -Encoding ascii "C:\secure\path\win-cert.pfx.b64"
```

Upload (bash, then PowerShell):
```bash
gh secret set WIN_CSC_LINK < /secure/path/win-cert.pfx.b64
gh secret set WIN_CSC_KEY_PASSWORD
```
```powershell
Get-Content -Raw "C:\secure\path\win-cert.pfx.b64" | gh secret set WIN_CSC_LINK
gh secret set WIN_CSC_KEY_PASSWORD
```
Delete the `.b64` file afterwards. Most certificate authorities now issue code signing keys only on hardware tokens or in a cloud service, so a downloadable `.pfx` is often not available for newly issued certificates. If your certificate cannot be exported, use mode 1 or 3 instead.

**SignPath values.** After SignPath approves the project, create an API token (for a user allowed to submit signing requests) and copy the organization ID, project slug, signing policy slug and, if you use a non-default one, the artifact configuration slug from the SignPath web app. Store the token and organization ID as secrets. The slugs are not sensitive, so you can store them as repository variables (Settings, Secrets and variables, Actions, Variables) or as secrets; the workflow reads the variable first, then the secret.
```bash
gh secret set SIGNPATH_API_TOKEN
gh secret set SIGNPATH_ORGANIZATION_ID
gh variable set SIGNPATH_PROJECT_SLUG --body "<project-slug>"
gh variable set SIGNPATH_POLICY_SLUG --body "<signing-policy-slug>"
gh variable set SIGNPATH_ARTIFACT_CONFIG_SLUG --body "<artifact-configuration-slug>"
```
In SignPath, the artifact configuration must describe a ZIP file whose root contains the two `.exe` files (`Ketabkhan-Studio-Windows-Setup.exe`, `Ketabkhan-Studio-Windows-Portable.exe`) as PE files to sign. SignPath signs the outer installer and portable files only; the files inside them stay as electron-builder built them. SignPath verifies the build origin, so the run must be on a GitHub-hosted runner of the repository registered in SignPath.

### 6.2 macOS modes

| Mode | Secrets | What happens |
|---|---|---|
| Signed and notarized | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, plus notarization credentials (A or B below) | electron-builder signs with the Developer ID certificate and notarizes the app. |
| Signed only | `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD` | Signed, notarization disabled. Gatekeeper still warns. |
| Unsigned | none | Same as before. |

Notarization credentials are ignored when the signing certificate is missing.

- **A. App Store Connect API key (preferred):** `APPLE_API_KEY_P8` (the full text of the `AuthKey_XXXX.p8` file), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (the issuer ID shown on the Keys page).
- **B. Apple ID:** `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (created at appleid.apple.com), `APPLE_TEAM_ID`.

If both A and B are complete, A is used.

**Certificate value.** In Keychain Access, export your "Developer ID Application" certificate together with its private key as a `.p12` file (the export password you choose is `MAC_CSC_KEY_PASSWORD`). Then encode and store it.

macOS:
```bash
base64 -i /secure/path/developer-id.p12 | tr -d '\n' > /secure/path/developer-id.p12.b64
gh secret set MAC_CSC_LINK < /secure/path/developer-id.p12.b64
gh secret set MAC_CSC_KEY_PASSWORD
```

Linux:
```bash
base64 -w 0 /secure/path/developer-id.p12 > /secure/path/developer-id.p12.b64
gh secret set MAC_CSC_LINK < /secure/path/developer-id.p12.b64
gh secret set MAC_CSC_KEY_PASSWORD
```

Windows PowerShell:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\path\developer-id.p12")) | Out-File -NoNewline -Encoding ascii "C:\secure\path\developer-id.p12.b64"
Get-Content -Raw "C:\secure\path\developer-id.p12.b64" | gh secret set MAC_CSC_LINK
gh secret set MAC_CSC_KEY_PASSWORD
```

**API key values.**
```bash
gh secret set APPLE_API_KEY_P8 < /secure/path/AuthKey_XXXXXXXXXX.p8
gh secret set APPLE_API_KEY_ID
gh secret set APPLE_API_ISSUER
```
```powershell
Get-Content -Raw "C:\secure\path\AuthKey_XXXXXXXXXX.p8" | gh secret set APPLE_API_KEY_P8
```
For the Apple ID route, run `gh secret set` for `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Delete the `.b64` and `.p12` working copies when done.

After a signed build the job runs `codesign --verify --deep --strict` on each `.app`. When notarized it also runs `xcrun stapler validate` and `spctl -a -t exec -vv` on each app, and checks the app inside each DMG. electron-builder staples the app before packing the DMG, so the DMG file itself usually has no ticket; the job only warns about that.

The mac build uses the hardened runtime and `build/entitlements.mac.plist` (JIT and unsigned executable memory, which Electron needs).

### 6.3 Providers (the owner's choice and the owner's identity checks)

- **SignPath Foundation:** free code signing for open-source projects (this repository is public and MIT). Apply first and wait for approval; they set conditions on the project and its build process.
- **Certum open-source code signing:** a low-cost certificate for open-source developers. Certificates are usually delivered on a card or through a cloud signing service, so they often cannot be used as a `.pfx` in CI. Check how the key is delivered before buying.
- **Azure Artifact Signing (formerly Trusted Signing):** pay-as-you-go. It needs identity validation and is available only in certain regions and for certain applicant types. Check the current list before you start.
- **Apple Developer Program:** USD 99 per year. Required for a Developer ID certificate and for notarization. Apple verifies your identity and may not be available in every country.

Identity validation and payment must be done by the owner. Nothing in this repository can do it for them.

## 7. Known limitations

- Windows and macOS builds are unsigned until the owner configures one of the modes in section 6. Until then users see the SmartScreen and Gatekeeper warnings described in the README.
- The v3.0.0 APK was signed with a temporary key. Users of v3.0.0 must export their notes and uninstall before installing the next version.
