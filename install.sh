#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${KETABKHAN_REPO:-https://github.com/am333ni7y/book-reader-studio.git}"
INSTALL_DIR="${KETABKHAN_HOME:-$HOME/.ketabkhan-studio}"
LOCAL_MODE=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --local) LOCAL_MODE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h)
      echo "Ketabkhan Studio Installer (macOS / Linux / Android Termux)"
      echo "Usage: ./install.sh [--local] [--dry-run]"
      exit 0
      ;;
  esac
done

IS_TERMUX=0
if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *"com.termux"* ]]; then
  IS_TERMUX=1
fi

echo "==> Ketabkhan Studio Installer"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] IS_TERMUX=$IS_TERMUX INSTALL_DIR=$INSTALL_DIR LOCAL_MODE=$LOCAL_MODE"
  exit 0
fi

# 1. Ensure Node.js >= 22.5 and git
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    return 1
  fi
  local ver major minor
  ver="$(node -v | sed 's/^v//')"
  major="${ver%%.*}"
  minor="${ver#*.}"
  minor="${minor%%.*}"
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }; then
    return 0
  fi
  return 1
}

if [ "$IS_TERMUX" -eq 1 ]; then
  echo "==> Detected Android Termux environment"
  if ! check_node || ! command -v git >/dev/null 2>&1; then
    pkg update -y
    pkg install -y nodejs git
  fi
else
  if ! check_node; then
    if command -v brew >/dev/null 2>&1; then
      echo "==> Installing/upgrading Node.js via Homebrew..."
      brew install node || brew upgrade node
    else
      echo "Error: Node.js >= 22.5.0 is required. Install it from https://nodejs.org and re-run." >&2
      exit 1
    fi
  fi
  if ! command -v git >/dev/null 2>&1 && [ "$LOCAL_MODE" -eq 0 ]; then
    echo "Error: git is required to clone the repository." >&2
    exit 1
  fi
fi

# 2. Install or link project files
if [ "$LOCAL_MODE" -eq 1 ]; then
  SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  echo "==> Linking local workspace: $SOURCE_DIR"
else
  SOURCE_DIR="$INSTALL_DIR"
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "==> Updating existing installation in $INSTALL_DIR..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    echo "==> Cloning Ketabkhan Studio into $INSTALL_DIR..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
  fi
fi

cd "$SOURCE_DIR"
if [ ! -d "$SOURCE_DIR/node_modules" ]; then
  echo "==> Installing dependencies..."
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --prod
  else
    npm install --omit=dev
  fi
fi

chmod +x "$SOURCE_DIR/bin/ketabkhan.mjs" "$SOURCE_DIR/start.sh"

# 3. Install `ketabkhan` CLI binary
if [ "$IS_TERMUX" -eq 1 ]; then
  BIN_TARGET="$PREFIX/bin/ketabkhan"
  ln -sf "$SOURCE_DIR/bin/ketabkhan.mjs" "$BIN_TARGET"
  mkdir -p "$HOME/.shortcuts"
  cat > "$HOME/.shortcuts/Ketabkhan Studio" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
exec ketabkhan start --open
EOF
  chmod +x "$HOME/.shortcuts/Ketabkhan Studio"
  echo "==> Installed Termux command: ketabkhan"
  echo "==> Created Termux:Widget shortcut: ~/.shortcuts/Ketabkhan Studio"
else
  BIN_DIR="$HOME/.local/bin"
  if [ -w "/opt/homebrew/bin" ]; then
    BIN_DIR="/opt/homebrew/bin"
  elif [ -w "/usr/local/bin" ]; then
    BIN_DIR="/usr/local/bin"
  fi
  mkdir -p "$BIN_DIR"
  ln -sf "$SOURCE_DIR/bin/ketabkhan.mjs" "$BIN_DIR/ketabkhan"
  echo "==> Installed CLI command: $BIN_DIR/ketabkhan"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo "Note: Add $BIN_DIR to your PATH (e.g. export PATH=\"$BIN_DIR:\$PATH\")"
      ;;
  esac
fi

echo ""
echo "Installation complete!"
echo "Run: ketabkhan --open        (start & open browser)"
echo "Run: ketabkhan --lan         (share over Wi-Fi with Android/tablet)"
echo "Run: ketabkhan add book.epub (import a PDF or EPUB from CLI)"
