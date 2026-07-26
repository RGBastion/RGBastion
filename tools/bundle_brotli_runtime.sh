#!/usr/bin/env bash
# Copy a self-contained brotli CLI (+ dylibs) into an app Resources directory.
# Usage: bundle_brotli_runtime.sh /path/to/App.app/Contents/Resources
set -Eeuo pipefail

DEST_ROOT="${1:-}"
[[ -n "$DEST_ROOT" ]] || {
  echo "usage: bundle_brotli_runtime.sh /path/to/Contents/Resources" >&2
  exit 2
}

OUT="$DEST_ROOT/brotli"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib"

resolve_brew_brotli() {
  local candidates=(
    /opt/homebrew/opt/brotli
    /usr/local/opt/brotli
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c/bin/brotli" && -d "$c/lib" ]]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  if command -v brew >/dev/null 2>&1; then
    local prefix=""
    prefix="$(brew --prefix brotli 2>/dev/null || true)"
    if [[ -n "$prefix" && -x "$prefix/bin/brotli" ]]; then
      printf '%s\n' "$prefix"
      return 0
    fi
  fi
  return 1
}

SRC="$(resolve_brew_brotli || true)"
if [[ -z "$SRC" ]]; then
  echo "WARNING: brotli not found via Homebrew; update extraction will need system brotli." >&2
  exit 0
fi

cp "$SRC/bin/brotli" "$OUT/bin/brotli"
chmod u+w,a+x "$OUT/bin/brotli"

# Copy every brotli dylib (real files + recreate stable .1 symlinks).
# Homebrew libs are often mode 444; wipe + chmod so re-runs never hit Permission denied.
shopt -s nullglob
for lib in "$SRC/lib"/libbrotli*.dylib; do
  base="$(basename "$lib")"
  if [[ -L "$lib" ]]; then
    target="$(readlink "$lib")"
    if [[ "$target" != /* ]]; then
      target="$(dirname "$lib")/$target"
    fi
    real_base="$(basename "$target")"
    if [[ -f "$target" ]]; then
      cp "$target" "$OUT/lib/$real_base"
      chmod u+w "$OUT/lib/$real_base" 2>/dev/null || true
    fi
    ln -sfn "$real_base" "$OUT/lib/$base"
  else
    cp "$lib" "$OUT/lib/$base"
    chmod u+w "$OUT/lib/$base" 2>/dev/null || true
  fi
done
shopt -u nullglob

# Ensure @loader_path/../lib rpath exists (Homebrew already sets this).
if command -v install_name_tool >/dev/null 2>&1; then
  if ! otool -l "$OUT/bin/brotli" 2>/dev/null | grep -q '@loader_path/../lib'; then
    install_name_tool -add_rpath '@loader_path/../lib' "$OUT/bin/brotli" 2>/dev/null || true
  fi
fi

if ! printf 'ok' | "$OUT/bin/brotli" -c 2>/dev/null | "$OUT/bin/brotli" -d -c 2>/dev/null | grep -q '^ok$'; then
  echo "ERROR: bundled brotli failed smoke test; removing incomplete runtime." >&2
  rm -rf "$OUT"
  exit 1
fi

echo "Bundled brotli runtime into: $OUT"
ls -la "$OUT/bin" "$OUT/lib"
