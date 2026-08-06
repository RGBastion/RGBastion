#!/usr/bin/env bash
# Build RedGalaxy / RedUniverse Bastion for Windows (.zip / .exe) via Electron.
# Run from any cwd; designed for macOS and Linux hosts.
#
# Usage:
#   ./tools/build_redgalaxy_bastion_exe.sh                 # both brands, zip+portable
#   BASTION_BRAND=redgalaxy ./tools/build_redgalaxy_bastion_exe.sh
#   BASTION_BRAND=reduniverse ./tools/build_redgalaxy_bastion_exe.sh portable
#   ./tools/build_redgalaxy_bastion_exe.sh zip|portable|nsis|dir|all
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
WIN_DIR="$PROJECT_DIR/tools/windows-bastion"
OUT_DIR="$PROJECT_DIR/dist/windows-bastion"
DIST_DIR="$PROJECT_DIR/dist"

TARGET="${1:-auto}" # auto | zip | portable | nsis | dir | all
BASTION_BRAND="${BASTION_BRAND:-both}"
BASTION_VERSION="$(tr -d '[:space:]' < "$SCRIPT_DIR/bastion_version.txt" 2>/dev/null || true)"
BASTION_VERSION="${BASTION_VERSION:-1.0.1}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

need node
need npm

strip_finder_duplicates() {
  local story_web="$1"
  [[ -d "$story_web" ]] || return 0
  echo "==> Removing Finder duplicate assets under $(basename "$story_web")..."
  python3 -c '
from pathlib import Path
import sys
root = Path(sys.argv[1])
n = b = 0
for p in sorted(root.rglob("*"), reverse=True):
    if not p.is_file():
        continue
    stem = p.stem
    if " " in stem and stem.rsplit(" ", 1)[-1].isdigit():
        b += p.stat().st_size
        p.unlink()
        n += 1
print(f"Removed {n} Finder duplicates ({b/1e6:.1f} MB)")
' "$story_web"
}

install_portable_nsi() {
  local template="$WIN_DIR/node_modules/app-builder-lib/templates/nsis/portable.nsi"
  local custom="$WIN_DIR/portable.nsi"
  [[ -f "$custom" ]] || {
    echo "Missing custom portable.nsi at $custom" >&2
    exit 1
  }
  [[ -f "$template" ]] || {
    echo "electron-builder portable.nsi template missing — run npm install first." >&2
    exit 1
  }
  if [[ ! -f "$template.stock" ]]; then
    cp -f "$template" "$template.stock"
  fi
  cp -f "$custom" "$template"
  echo "==> Installed persistent-unpack portable.nsi (stock backup: portable.nsi.stock)"
}

configure_brand_package_json() {
  local brand="$1"
  local product_name app_id dmg_slug unpack_dir story_web shortcut
  case "$brand" in
    redgalaxy)
      product_name="RedGalaxy Bastion"
      app_id="local.redgalaxy.bastion"
      dmg_slug="RedGalaxy-Bastion"
      unpack_dir="RedGalaxyBastionPortable"
      shortcut="RedGalaxy Bastion"
      ;;
    reduniverse)
      product_name="RedUniverse Bastion"
      app_id="local.reduniverse.bastion"
      dmg_slug="RedUniverse-Bastion"
      unpack_dir="RedUniverseBastionPortable"
      shortcut="RedUniverse Bastion"
      ;;
    *)
      echo "Unknown brand='$brand'" >&2
      exit 1
      ;;
  esac
  story_web="../../artifacts/redgalaxy-story-web-$brand"

  node -e '
const fs = require("fs");
const p = "package.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
const brand = process.argv[1];
const version = process.argv[2];
const productName = process.argv[3];
const appId = process.argv[4];
const slug = process.argv[5];
const unpackDir = process.argv[6];
const shortcut = process.argv[7];
const storyWeb = process.argv[8];
j.name = brand === "redgalaxy" ? "redgalaxy-bastion" : "reduniverse-bastion";
j.version = version;
j.description = productName + " — story/autopilot Windows host (Electron + local HTTP)";
j.author = productName;
j.build = j.build || {};
j.build.appId = appId;
j.build.productName = productName;
j.build.copyright = productName;
j.build.extraResources = (j.build.extraResources || []).map((entry) => {
  if (entry && entry.to === "web") {
    return { ...entry, from: storyWeb };
  }
  return entry;
});
j.build.win = j.build.win || {};
j.build.win.artifactName = slug + "-${version}-${arch}.${ext}";
j.build.win.executableName = slug;
j.build.portable = j.build.portable || {};
j.build.portable.artifactName = slug + ".${ext}";
j.build.portable.unpackDirName = unpackDir;
j.build.nsis = j.build.nsis || {};
j.build.nsis.shortcutName = shortcut;
j.build.nsis.artifactName = slug + "-Setup.${ext}";
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("Configured package.json for", productName, "v" + version);
' "$brand" "$BASTION_VERSION" "$product_name" "$app_id" "$dmg_slug" "$unpack_dir" "$shortcut" "$story_web"
}

gate_brand_web() {
  local brand="$1"
  local web_dir="$2"
  local index="$web_dir/index.html"
  [[ -f "$index" ]] || {
    echo "Story web assets missing: $index" >&2
    exit 1
  }
  for needle in '__RG_STORY_MODE__' '/story/i18n.js' '/story/autopilot.js'; do
    if ! grep -q "$needle" "$index"; then
      echo "ERROR: $needle missing from $index" >&2
      exit 1
    fi
  done
  if [[ "$brand" == "redgalaxy" ]]; then
    if rg -q 'RedUniverse Bastion' "$web_dir/story/i18n.js" "$web_dir/story/autopilot.js" 2>/dev/null; then
      echo "Refusing to package RedGalaxy Bastion with RedUniverse Bastion UI strings." >&2
      exit 1
    fi
    if ! rg -q '"app.title": "RedGalaxy Bastion"' "$web_dir/story/i18n.js"; then
      echo "RedGalaxy story i18n missing RedGalaxy Bastion app.title" >&2
      exit 1
    fi
    local main_js
    main_js="$(rg -o 'assets/index-[^\"'\'']+\.js' "$index" | head -1 || true)"
    if [[ -z "$main_js" || ! -f "$web_dir/$main_js" ]]; then
      echo "RedGalaxy Bastion missing game entry JS" >&2
      exit 1
    fi
    if rg -q 'aws-prod-api\.reduniverse\.space|aws-test-api\.reduniverse\.space' "$web_dir/$main_js"; then
      echo "Refusing to package RedGalaxy Bastion with RedUniverse game APIs." >&2
      exit 1
    fi
    if ! rg -q 'redgalaxygame\.space' "$web_dir/$main_js"; then
      echo "Refusing to package RedGalaxy Bastion without redgalaxygame.space game APIs." >&2
      exit 1
    fi
  else
    local main_js
    main_js="$(rg -o 'assets/index-[^\"'\'']+\.js' "$index" | head -1 || true)"
    if [[ -n "$main_js" && -f "$web_dir/$main_js" ]]; then
      if rg -q 'aws-prod-api\.redgalaxygame\.space|aws-api\.redgalaxygame\.space' "$web_dir/$main_js"; then
        echo "Refusing to package RedUniverse Bastion with RedGalaxy game APIs." >&2
        exit 1
      fi
      if ! rg -q 'reduniverse\.space' "$web_dir/$main_js"; then
        echo "Refusing to package RedUniverse Bastion without reduniverse.space game APIs." >&2
        exit 1
      fi
    fi
  fi
}

pick_targets() {
  case "$TARGET" in
    auto)
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

publish_brand_artifacts() {
  local brand="$1"
  local slug
  case "$brand" in
    redgalaxy) slug="RedGalaxy-Bastion" ;;
    reduniverse) slug="RedUniverse-Bastion" ;;
  esac

  echo "==> Publishing $slug convenience copies under dist/"
  mkdir -p "$DIST_DIR"
  shopt -s nullglob
  # Only current version artifacts — avoid Finder "Copy" duplicates and old builds.
  for f in "$OUT_DIR"/"$slug-${BASTION_VERSION}-x64.zip" "$OUT_DIR"/"$slug.exe"; do
    [[ -f "$f" ]] || continue
    cp -f "$f" "$DIST_DIR/$(basename "$f")"
    echo "Copied: $DIST_DIR/$(basename "$f")"
  done
  # Also keep versioned portable if electron-builder emitted one.
  for f in "$OUT_DIR"/"$slug-${BASTION_VERSION}"*.exe; do
    [[ -f "$f" ]] || continue
    cp -f "$f" "$DIST_DIR/$(basename "$f")"
    echo "Copied: $DIST_DIR/$(basename "$f")"
  done
  shopt -u nullglob

  cat > "$DIST_DIR/${slug}-Windows-README.txt" <<EOF
${slug//-/ } — Windows
===========================

Files:
  ${slug}.exe                      Portable single-file app (recommended)
  ${slug}-*-x64.zip                Unpacked Electron folder (alternative)

Startup note:
  First launch unpacks Electron into %LOCALAPPDATA% once (~same size as the zip).
  Later launches reuse that folder (no multi-minute re-extract).

Usage:
  1. Copy ${slug}.exe to a Windows PC
  2. Double-click to launch
  3. Log in, enter map, open Security tab for license
  4. Press Play in the Bastion panel

Game updates (no Bastion rebuild):
  - Launch check + Security tab "Update game"
  - Official assets → %APPDATA%\\${brand}-bastion\\game-web\\web
  - Autopilot/license re-applied from Bastion bundle

Version: ${BASTION_VERSION}
License product: redgalaxy-story
Rebuild: ./tools/build_redgalaxy_bastion_exe.sh
EOF
}

build_one_brand() {
  local brand="$1"
  local story_web="$PROJECT_DIR/artifacts/redgalaxy-story-web-$brand"
  local slug
  case "$brand" in
    redgalaxy) slug="RedGalaxy-Bastion" ;;
    reduniverse) slug="RedUniverse-Bastion" ;;
  esac

  echo
  echo "======== Building Windows Bastion brand=$brand version=$BASTION_VERSION ========"

  chmod +x "$SCRIPT_DIR/prepare_redgalaxy_story_web.sh"
  "$SCRIPT_DIR/prepare_redgalaxy_story_web.sh" --brand "$brand"
  strip_finder_duplicates "$story_web"
  gate_brand_web "$brand" "$story_web"

  cd "$WIN_DIR"
  configure_brand_package_json "$brand"

  if [[ ! -d node_modules/electron || ! -d node_modules/electron-builder ]]; then
    npm install
  else
    npm install --prefer-offline --no-audit --no-fund
  fi
  install_portable_nsi

  mkdir -p "$OUT_DIR"
  local targets failed
  targets="$(pick_targets)"
  echo "==> Packaging Windows targets for $brand: $targets"
  failed=0
  for t in $targets; do
    echo "---- building $brand / $t ----"
    if ! npx electron-builder --win "$t" --x64; then
      echo "WARN: electron-builder failed for target: $t (brand=$brand)" >&2
      failed=1
      if [[ "$t" == "zip" || "$t" == "dir" ]]; then
        exit 1
      fi
    fi
  done

  shopt -s nullglob
  local produced=( "$OUT_DIR"/"$slug"*.zip "$OUT_DIR"/"$slug"*.exe )
  shopt -u nullglob
  if [[ "$failed" == "1" && ${#produced[@]} -eq 0 ]]; then
    echo "No Windows artifacts were produced for brand=$brand." >&2
    exit 1
  fi

  publish_brand_artifacts "$brand"
}

case "$BASTION_BRAND" in
  both)
    build_one_brand redgalaxy
    build_one_brand reduniverse
    ;;
  redgalaxy|reduniverse)
    build_one_brand "$BASTION_BRAND"
    ;;
  *)
    echo "Unknown BASTION_BRAND='$BASTION_BRAND' (use redgalaxy|reduniverse|both)" >&2
    exit 1
    ;;
esac

echo
echo "Done. Artifacts:"
ls -lh "$OUT_DIR" 2>/dev/null | sed -n '1,60p' || true
echo
ls -lh "$DIST_DIR"/RedGalaxy-Bastion* "$DIST_DIR"/RedUniverse-Bastion* 2>/dev/null || true
