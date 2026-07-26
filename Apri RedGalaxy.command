#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="/Users/andersonguillin/Documents/Codex/2026-07-06/ci-sono-dei-piccoli-giochi-exe"
exec "$PROJECT_DIR/bin/redgalaxy-mac-runner" serve-web-foreground
