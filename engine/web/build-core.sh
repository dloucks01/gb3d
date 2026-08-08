#!/usr/bin/env bash
# Bundle the (CommonJS) Game Boy emulator core into a browser IIFE that exposes
# window.GameBoyCore. We drive the core ourselves and read VRAM/OAM out of it;
# its own renderer is unused. Regenerates web/gbcore.bundle.js (gitignored).
#
# The core is serverboy's vendored Gameboy-Online (GPL). It is a dev/runtime
# dependency pulled via npm, not committed — run this after `npm install`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
[ -d node_modules/serverboy ] || { echo "run 'npm install' first" >&2; exit 1; }
node_modules/.bin/esbuild web/entry.js --bundle --format=iife \
  --global-name=GBBUNDLE --outfile=web/gbcore.bundle.js --log-level=warning
echo "wrote web/gbcore.bundle.js"
