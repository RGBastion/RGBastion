#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
STORY_DIR="$SCRIPT_DIR/story"
PATCHER="$SCRIPT_DIR/apply_bastion_patches.py"
BRAND="${BASTION_BRAND:-redgalaxy}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --brand)
      BRAND="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1 (use --brand redgalaxy)" >&2
      exit 1
      ;;
  esac
done

case "$BRAND" in
  redgalaxy|"")
    BRAND="redgalaxy"
    ;;
  reduniverse|both|all)
    echo "RedUniverse Bastion prepare is disabled. Use --brand redgalaxy (default)." >&2
    exit 1
    ;;
  *)
    echo "Unknown brand='$BRAND' (only redgalaxy is supported)" >&2
    exit 1
    ;;
esac

# RedGalaxy Bastion only — never mix with RedUniverse game extracts.
#   artifacts/redgalaxy-native-web-redgalaxy ← RedGalaxy client (redgalaxygame.space)
SRC_WEB="$PROJECT_DIR/artifacts/redgalaxy-native-web-$BRAND"
DST_WEB="$PROJECT_DIR/artifacts/redgalaxy-story-web-$BRAND"

[[ -f "$SRC_WEB/index.html" ]] || {
  echo "Missing $BRAND game web assets: $SRC_WEB/index.html" >&2
  echo "Extract the matching installer first, e.g.:" >&2
  echo "  BASTION_BRAND=redgalaxy ./bin/redgalaxy-mac-runner extract-web --exe ~/Desktop/RedGalaxy-Setup.exe" >&2
  exit 1
}

# Hard gate: refuse to prepare RG Bastion from a RedUniverse game extract.
main_js="$(grep -oE 'assets/index-[^\"'\'']+\.js' "$SRC_WEB/index.html" | head -1 || true)"
if [[ -n "$main_js" && -f "$SRC_WEB/$main_js" ]]; then
  if grep -q 'aws-prod-api\.reduniverse\.space\|aws-test-api\.reduniverse\.space' "$SRC_WEB/$main_js"; then
    echo "Refusing: $SRC_WEB is a RedUniverse game extract (reduniverse.space APIs)." >&2
    echo "RedGalaxy Bastion requires redgalaxygame.space game assets." >&2
    exit 1
  fi
  if ! grep -q 'redgalaxygame\.space' "$SRC_WEB/$main_js"; then
    echo "Refusing: $SRC_WEB missing redgalaxygame.space — not a RedGalaxy game extract." >&2
    exit 1
  fi
fi

[[ -f "$PATCHER" ]] || {
  echo "Missing Bastion patcher: $PATCHER" >&2
  exit 1
}

python3 "$PATCHER" --game-src "$SRC_WEB" --story-src "$STORY_DIR" --out "$DST_WEB" --brand "$BRAND"
echo "Prepared story web root: $DST_WEB (brand=$BRAND, game-src=$SRC_WEB)"
