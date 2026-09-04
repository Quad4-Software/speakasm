#!/usr/bin/env bash
# Vendor kokoro-js browser bundle + onnxruntime wasm into web/vendor/kokoro.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT/scripts/vendor"
OUT_DIR="$ROOT/web/vendor/kokoro"
JSZIP_DIR="$ROOT/web/vendor/jszip"

mkdir -p "$OUT_DIR" "$JSZIP_DIR"

cd "$VENDOR_DIR"
if [[ ! -d node_modules/kokoro-js ]]; then
  echo "installing kokoro-js"
  npm install --no-fund --no-audit
fi

WEB_BUNDLE="$VENDOR_DIR/node_modules/kokoro-js/dist/kokoro.web.js"
if [[ ! -f "$WEB_BUNDLE" ]]; then
  echo "missing kokoro.web.js" >&2
  exit 1
fi
cp -f "$WEB_BUNDLE" "$OUT_DIR/kokoro.js"

ORT_DIRS=(
  "$VENDOR_DIR/node_modules/onnxruntime-web/dist"
  "$VENDOR_DIR/node_modules/@huggingface/transformers/dist"
  "$VENDOR_DIR/node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist"
)

shopt -s nullglob
for ORT_DIR in "${ORT_DIRS[@]}"; do
  [[ -d "$ORT_DIR" ]] || continue
  for f in \
    "$ORT_DIR"/ort-wasm-simd-threaded*.wasm \
    "$ORT_DIR"/ort-wasm-simd-threaded*.mjs \
    "$ORT_DIR"/ort-wasm-simd-threaded*.js
  do
    base="$(basename "$f")"
    if [[ ! -f "$OUT_DIR/$base" ]]; then
      cp -f "$f" "$OUT_DIR/$base"
    fi
  done
done
shopt -u nullglob

(
  cd "$OUT_DIR"
  python3 - <<'PY'
import json
from pathlib import Path
files = sorted(p.name for p in Path('.').iterdir() if p.is_file() and p.name != 'manifest.json')
Path('manifest.json').write_text(json.dumps({'files': files}, indent=2) + '\n')
print('manifest files:', len(files))
PY
)

if [[ ! -f "$JSZIP_DIR/jszip.min.js" ]]; then
  echo "fetching jszip"
  curl -L --fail --retry 5 --retry-delay 2 \
    -o "$JSZIP_DIR/jszip.min.js" \
    "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
fi

echo "vendor ready: $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
