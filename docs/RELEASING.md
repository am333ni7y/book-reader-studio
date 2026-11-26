# Releasing Ketabkhan Studio

This document covers the Android signing key and the tag-based release flow. The workflow is `.github/workflows/release-apps.yml`.

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

## 6. Known limitations

- Windows and macOS builds are not code-signed or notarized yet. Users see the SmartScreen and Gatekeeper warnings described in the README.
- The v3.0.0 APK was signed with a temporary key. Users of v3.0.0 must export their notes and uninstall before installing the next version.
