$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:KETABKHAN_REPO) { $env:KETABKHAN_REPO } else { "https://github.com/am333ni7y/book-reader-studio.git" }
$InstallDir = if ($env:KETABKHAN_HOME) { $env:KETABKHAN_HOME } else { Join-Path $env:USERPROFILE ".ketabkhan-studio" }
$BinDir = Join-Path $InstallDir "bin"

Write-Host "==> Ketabkhan Studio Windows Installer" -ForegroundColor Cyan

function Test-NodeVersion {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { return $false }
  $ver = (node -v).Trim().TrimStart('v')
  $parts = $ver.Split('.')
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 5)
}

if (-not (Test-NodeVersion)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "==> Installing Node.js LTS via winget..."
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
  }
  if (-not (Test-NodeVersion)) {
    Write-Error "Node.js >= 22.5.0 is required. Please install Node.js from https://nodejs.org and re-run."
  }
}

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Host "==> Updating existing installation in $InstallDir..."
  git -C $InstallDir pull --ff-only
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Host "==> Cloning repository into $InstallDir..."
  git clone --depth 1 $RepoUrl $InstallDir
} else {
  Write-Host "==> Downloading archive from GitHub..."
  $zipPath = Join-Path $env:TEMP "ketabkhan-studio.zip"
  $extractPath = Join-Path $env:TEMP "ketabkhan-extract"
  Invoke-WebRequest -Uri "https://github.com/am333ni7y/book-reader-studio/archive/refs/heads/main.zip" -OutFile $zipPath
  if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $inner = Get-ChildItem $extractPath | Select-Object -First 1
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Move-Item $inner.FullName $InstallDir
}

Push-Location $InstallDir
try {
  Write-Host "==> Installing dependencies..."
  npm.cmd install --omit=dev
} finally {
  Pop-Location
}

if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
$shimPath = Join-Path $BinDir "ketabkhan.cmd"
"@echo off`r`nnode `"%~dp0ketabkhan.mjs`" %*`r`n" | Set-Content -Path $shimPath -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "==> Added $BinDir to User PATH (restart terminal to use 'ketabkhan')" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "Run: ketabkhan --open        (start & open browser)"
Write-Host "Run: ketabkhan --lan         (share over Wi-Fi with Android/tablet)"
Write-Host "Run: ketabkhan add book.epub (import a PDF or EPUB from CLI)"
