#!/usr/bin/env bash
# Fetch offline Kokoro ONNX weights, voices, fonts, and JS vendors into web/.
# Usage: fetch-assets.sh [--shell]
#   --shell  fonts + vendor only (skip ONNX weights, for Lighthouse shell gates)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$ROOT/web/models/Kokoro-82M-v1.0-ONNX"
FONT_DIR="$ROOT/web/fonts"
HF="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main"

SHELL_ONLY=0
if [[ "${1:-}" == "--shell" ]]; then
  SHELL_ONLY=1
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--shell]" >&2
  exit 2
fi

mkdir -p "$FONT_DIR"

download() {
  local url="$1"
  local dest="$2"
  if [[ -f "$dest" && -s "$dest" ]]; then
    echo "present: $dest"
    return 0
  fi
  echo "fetching $url"
  curl -L --fail --retry 5 --retry-delay 2 -o "$dest" "$url"
}

if [[ "$SHELL_ONLY" -eq 0 ]]; then
  mkdir -p "$MODEL_DIR/onnx" "$MODEL_DIR/voices"

  download "$HF/config.json" "$MODEL_DIR/config.json"
  download "$HF/tokenizer.json" "$MODEL_DIR/tokenizer.json"
  download "$HF/tokenizer_config.json" "$MODEL_DIR/tokenizer_config.json"
  download "$HF/onnx/model_quantized.onnx" "$MODEL_DIR/onnx/model_quantized.onnx"

  VOICES=(
    af_heart af_bella af_sarah af_nicole af_nova af_sky
    am_adam am_michael am_fenrir am_puck
    bf_emma bf_isabella bm_george bm_lewis
  )

  for voice in "${VOICES[@]}"; do
    download "$HF/voices/${voice}.bin" "$MODEL_DIR/voices/${voice}.bin"
  done
fi

download "https://cdn.jsdelivr.net/fontsource/fonts/bricolage-grotesque@5.2.8/latin-700-normal.woff2" \
  "$FONT_DIR/bricolage-700.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/source-sans-3@5.2.8/latin-400-normal.woff2" \
  "$FONT_DIR/source-sans-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/source-sans-3@5.2.8/latin-600-normal.woff2" \
  "$FONT_DIR/source-sans-600.woff2"

bash "$ROOT/scripts/vendor-kokoro.sh"

if [[ "$SHELL_ONLY" -eq 1 ]]; then
  echo "shell assets ready (fonts + vendor)"
else
  echo "offline assets ready"
fi
