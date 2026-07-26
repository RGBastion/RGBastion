#!/usr/bin/env bash
# Build RedGalaxy Bastion for Windows (.zip / .exe) via Electron.
# Run from any cwd; designed for macOS and Linux hosts.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WIN_DIR="$PROJECT_DIR/tools/windows-bastion"
OUT_DIR="$PROJECT_DIR/dist/windows-bastion"
DIST_DIR="$PROJECT_DIR/dist"

TARGET="${1:-auto}" # auto | zip | portable | nsis | dir | all

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need node
need npm

echo "==> Preparing story web assets (same as macOS Bastion DMG)..."
chmod +x "$SCRIPT_DIR/prepare_redgalaxy_story_web.sh"
"$SCRIPT_DIR/prepare_redgalaxy_story_web.sh"

[[ -f "$PROJECT_DIR/artifacts/redgalaxy-story-web/index.html" ]] || {
  echo "Story web assets missing after prepare." >&2
  exit 1
}

if ! grep -q '__RG_STORY_MODE__' "$PROJECT_DIR/artifacts/redgalaxy-story-web/index.html"; then
  echo "ERROR: __RG_STORY_MODE__ hook missing from index.html" >&2
  exit 1
fi
if ! grep -q '/story/i18n.js' "$PROJECT_DIR/artifacts/redgalaxy-story-web/index.html"; then
  echo "ERROR: story/i18n.js missing from index.html" >&2
  exit 1
fi
if ! grep -q '/story/autopilot.js' "$PROJECT_DIR/artifacts/redgalaxy-story-web/index.html"; then
  echo "ERROR: story/autopilot.js missing from index.html" >&2
  exit 1
fi

echo "==> Installing Electron build deps..."
cd "$WIN_DIR"

# Keep Electron package version aligned with tools/bastion_version.txt
BASTION_VERSION="$(tr -d '[:space:]' < "$SCRIPT_DIR/bastion_version.txt" 2>/dev/null || true)"
BASTION_VERSION="${BASTION_VERSION:-1.0.5}"
if command -v node >/dev/null 2>&1; then
  node -e "
    const fs=require('fs');
    const p='package.json';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    if (j.version !== process.argv[1]) {
      j.version = process.argv[1];
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
      console.log('Synced package.json version to', process.argv[1]);
    }
  " "$BASTION_VERSION"
fi

if [[ ! -d node_modules/electron || ! -d node_modules/electron-builder ]]; then
  npm install
else
  npm install --prefer-offline --no-audit --no-fund
fi

mkdir -p "$OUT_DIR"

pick_targets() {
  case "$TARGET" in
    auto)
      # Prefer zip + portable. electron-builder can produce portable on macOS
      # using its bundled Wine helper (no system Wine required).
      echo "zip portable"
      ;;
    all)
      echo "zip portable nsis"
      ;;
    zip|portable|nsis|dir)
      echo "$TARGET"
      ;;
    *)
      echo "Unknown target: $TARGET (use auto|zip|portable|nsis|dir|all)" >&2
      exit 2
      ;;
  esac
}

TARGETS="$(pick_targets)"
echo "==> Packaging Windows targets: $TARGETS"

# electron-builder downloads Windows Electron binaries; needs network.
# Build each target separately so a Wine-less Mac can still produce zip.
FAILED=0
for t in $TARGETS; do
  echo "---- building $t ----"
  if ! npx electron-builder --win "$t" --x64; then
    echo "WARN: electron-builder failed for target: $t" >&2
    FAILED=1
    if [[ "$t" == "zip" || "$t" == "dir" ]]; then
      exit 1
    fi
  fi
done

shopt -s nullglob
PRODUCED=( "$OUT_DIR"/RedGalaxy-Bastion*.zip "$OUT_DIR"/RedGalaxy-Bastion*.exe )
shopt -u nullglob
if [[ "$FAILED" == "1" && ${#PRODUCED[@]} -eq 0 ]]; then
  echo "No Windows artifacts were produced." >&2
  exit 1
fi

echo "==> Publishing convenience copies under dist/"
shopt -s nullglob
for f in "$OUT_DIR"/RedGalaxy-Bastion*.zip; do
  cp -f "$f" "$DIST_DIR/$(basename "$f")"
  echo "Copied: $DIST_DIR/$(basename "$f")"
done
for f in "$OUT_DIR"/RedGalaxy-Bastion.exe "$OUT_DIR"/RedGalaxy-Bastion*.exe; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  cp -f "$f" "$DIST_DIR/$base"
  echo "Copied: $DIST_DIR/$base"
  # Canonical name for the portable single-file build.
  if [[ "$base" == "RedGalaxy-Bastion.exe" ]]; then
    :
  elif [[ "$base" == RedGalaxy-Bastion*.exe ]] && [[ ! -f "$DIST_DIR/RedGalaxy-Bastion.exe" ]]; then
    cp -f "$f" "$DIST_DIR/RedGalaxy-Bastion.exe"
    echo "Copied: $DIST_DIR/RedGalaxy-Bastion.exe"
  fi
done
shopt -u nullglob

cat > "$DIST_DIR/RedGalaxy-Bastion-Windows-README.txt" <<'EOF'
RedGalaxy Bastion — Windows
===========================

Files:
  RedGalaxy-Bastion.exe              Portable single-file app (recommended)
  RedGalaxy-Bastion-*-x64.zip        Unpacked Electron folder (alternative)

Usage:
  1. Copy RedGalaxy-Bastion.exe to a Windows PC
  2. Double-click to launch
  3. Log in to RedGalaxy, enter map, open Security tab for license
  4. Press Play in the Bastion panel

Game updates (no Bastion rebuild):
  - Launch check + Security tab "Update game"
  - Official assets → %APPDATA%\redgalaxy-bastion\game-web\web
  - Autopilot/license re-applied from Bastion bundle
  - Uses bundled Node extract/patch (no Python required); fallback = bundled web

License product: redgalaxy-story
Story hooks: __RG_STORY_MODE__, /story/i18n.js, /story/autopilot.js

Rebuild:
  ./tools/build_redgalaxy_bastion_exe.sh
  .\tools\build_redgalaxy_bastion_exe.ps1
EOF

echo
echo "Done. Artifacts:"
ls -lh "$OUT_DIR" 2>/dev/null | sed -n '1,40p' || true
echo
ls -lh "$DIST_DIR"/RedGalaxy-Bastion* 2>/dev/null || true
