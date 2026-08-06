#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STORY_DIR="$SCRIPT_DIR/story"
PATCHER="$SCRIPT_DIR/apply_bastion_patches.py"
BRAND="${BASTION_BRAND:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --brand)
      BRAND="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1 (use --brand redgalaxy|reduniverse)" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BRAND" ]]; then
  echo "Usage: prepare_redgalaxy_story_web.sh --brand redgalaxy|reduniverse" >&2
  echo "Or: BASTION_BRAND=redgalaxy $0" >&2
  exit 1
fi

case "$BRAND" in
  redgalaxy|reduniverse) ;;
  *)
    echo "Unknown brand='$BRAND' (use redgalaxy|reduniverse)" >&2
    exit 1
    ;;
esac

# Dual extracts: never share one game payload across brands.
#   artifacts/redgalaxy-native-web-redgalaxy   ← RedGalaxy client (redgalaxygame.space)
#   artifacts/redgalaxy-native-web-reduniverse ← RedUniverse client (reduniverse.space)
SRC_WEB="$PROJECT_DIR/artifacts/redgalaxy-native-web-$BRAND"
DST_WEB="$PROJECT_DIR/artifacts/redgalaxy-story-web-$BRAND"

[[ -f "$SRC_WEB/index.html" ]] || {
  echo "Missing $BRAND game web assets: $SRC_WEB/index.html" >&2
  echo "Extract the matching installer first, e.g.:" >&2
  if [[ "$BRAND" == "redgalaxy" ]]; then
    echo "  BASTION_BRAND=redgalaxy ./bin/redgalaxy-mac-runner extract-web --exe ~/Desktop/RedGalaxy-Setup.exe" >&2
  else
    echo "  BASTION_BRAND=reduniverse ./bin/redgalaxy-mac-runner extract-web --exe ~/Desktop/RedUniverse_*_setup.exe" >&2
  fi
  exit 1
}

# Hard gate: refuse to prepare RG Bastion from a RedUniverse game extract (or vice versa).
main_js="$(grep -oE 'assets/index-[^\"'\'']+\.js' "$SRC_WEB/index.html" | head -1 || true)"
if [[ -n "$main_js" && -f "$SRC_WEB/$main_js" ]]; then
  if [[ "$BRAND" == "redgalaxy" ]]; then
    if grep -q 'aws-prod-api\.reduniverse\.space\|aws-test-api\.reduniverse\.space' "$SRC_WEB/$main_js"; then
      echo "Refusing: $SRC_WEB is a RedUniverse game extract (reduniverse.space APIs)." >&2
      echo "RedGalaxy Bastion requires redgalaxygame.space game assets." >&2
      exit 1
    fi
    if ! grep -q 'redgalaxygame\.space' "$SRC_WEB/$main_js"; then
      echo "Refusing: $SRC_WEB missing redgalaxygame.space — not a RedGalaxy game extract." >&2
      exit 1
    fi
  else
    if grep -q 'aws-prod-api\.redgalaxygame\.space\|aws-api\.redgalaxygame\.space' "$SRC_WEB/$main_js"; then
      echo "Refusing: $SRC_WEB is a RedGalaxy game extract (redgalaxygame.space APIs)." >&2
      echo "RedUniverse Bastion requires reduniverse.space game assets." >&2
      exit 1
    fi
    if ! grep -q 'reduniverse\.space' "$SRC_WEB/$main_js"; then
      echo "Refusing: $SRC_WEB missing reduniverse.space — not a RedUniverse game extract." >&2
      exit 1
    fi
  fi
fi

[[ -f "$PATCHER" ]] || {
  echo "Missing Bastion patcher: $PATCHER" >&2
  exit 1
}

python3 "$PATCHER" --game-src "$SRC_WEB" --story-src "$STORY_DIR" --out "$DST_WEB" --brand "$BRAND"
echo "Prepared story web root: $DST_WEB (brand=$BRAND, game-src=$SRC_WEB)"
