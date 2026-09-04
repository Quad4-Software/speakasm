#!/usr/bin/env bash
# Build Chrome CRX/ZIP and Firefox XPI into web/build for site + release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="$(basename "$ROOT")"
VERSION="${VERSION:-}"
if [[ -z "$VERSION" ]]; then
  if [[ "${GITHUB_REF_TYPE:-}" == "tag" && "${GITHUB_REF_NAME:-}" == v* ]]; then
    VERSION="${GITHUB_REF_NAME#v}"
  elif git describe --tags --exact-match >/dev/null 2>&1; then
    VERSION="$(git describe --tags --exact-match | sed 's/^v//')"
  else
    VERSION="$(sed -n 's/^VERSION[[:space:]]*?=[[:space:]]*//p' Makefile | head -1 | tr -d '[:space:]')"
  fi
fi
VERSION="${VERSION:-0.0.0}"
if ! [[ "$VERSION" =~ ^[0-9]+(\.[0-9]+){1,3}$ ]]; then
  VERSION="0.0.0"
fi

OUT="${OUT:-$ROOT/web/build}"
STAGE="$ROOT/.build/extensions"
if [[ -n "${EXTENSION_PEM:-}" && -f "${EXTENSION_PEM}" ]]; then
  KEY="$EXTENSION_PEM"
else
  KEY="$ROOT/extension/signing.pem"
fi
CHROME_SRC="$ROOT/extension/chrome"
FIREFOX_SRC="$ROOT/extension/firefox"

mkdir -p "$OUT" "$STAGE"
rm -rf "$STAGE/chrome" "$STAGE/firefox"
cp -a "$CHROME_SRC" "$STAGE/chrome"
cp -a "$FIREFOX_SRC" "$STAGE/firefox"

stamp_manifest() {
  local file="$1"
  python3 - "$file" "$VERSION" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
data["version"] = version
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

stamp_manifest "$STAGE/chrome/manifest.json"
stamp_manifest "$STAGE/firefox/manifest.json"

if [[ ! -f "$KEY" ]]; then
  echo "missing signing key: $KEY" >&2
  echo "generate with: openssl genrsa -out extension/signing.pem 2048" >&2
  exit 1
fi

CHROME_ZIP="$OUT/${APP}-chrome-${VERSION}.zip"
CHROME_CRX="$OUT/${APP}-chrome-${VERSION}.crx"
FIREFOX_XPI="$OUT/${APP}-firefox-${VERSION}.xpi"
LATEST_CHROME_ZIP="$OUT/${APP}-chrome.zip"
LATEST_CHROME_CRX="$OUT/${APP}-chrome.crx"
LATEST_FIREFOX_XPI="$OUT/${APP}-firefox.xpi"

rm -f "$CHROME_ZIP" "$CHROME_CRX" "$FIREFOX_XPI" \
  "$LATEST_CHROME_ZIP" "$LATEST_CHROME_CRX" "$LATEST_FIREFOX_XPI"

(
  cd "$STAGE/chrome"
  zip -qr -FS "$CHROME_ZIP" .
)
(
  cd "$STAGE/firefox"
  zip -qr -FS "$FIREFOX_XPI" .
)

pack_crx() {
  if command -v chromium >/dev/null 2>&1; then
    local pack_dir="$STAGE/chrome"
    local packed_crx="$STAGE/chrome.crx"
    rm -f "$packed_crx"
    chromium --headless=new --pack-extension="$pack_dir" --pack-extension-key="$KEY" >/dev/null 2>&1 \
      || chromium --pack-extension="$pack_dir" --pack-extension-key="$KEY"
    mv -f "$packed_crx" "$CHROME_CRX"
    return
  fi
  if command -v npx >/dev/null 2>&1; then
    npx --yes crx@5.0.1 pack "$STAGE/chrome" -o "$CHROME_CRX" -p "$KEY"
    return
  fi
  echo "need chromium or npx to build CRX" >&2
  exit 1
}

pack_crx

cp -f "$CHROME_ZIP" "$LATEST_CHROME_ZIP"
cp -f "$CHROME_CRX" "$LATEST_CHROME_CRX"
cp -f "$FIREFOX_XPI" "$LATEST_FIREFOX_XPI"

chmod a+r "$CHROME_ZIP" "$CHROME_CRX" "$FIREFOX_XPI" \
  "$LATEST_CHROME_ZIP" "$LATEST_CHROME_CRX" "$LATEST_FIREFOX_XPI"

(
  cd "$OUT"
  sha256sum \
    "$(basename "$CHROME_ZIP")" \
    "$(basename "$CHROME_CRX")" \
    "$(basename "$FIREFOX_XPI")" \
    "$(basename "$LATEST_CHROME_ZIP")" \
    "$(basename "$LATEST_CHROME_CRX")" \
    "$(basename "$LATEST_FIREFOX_XPI")" \
    > SHA256SUMS
)

python3 - "$OUT" "$APP" "$VERSION" <<'PY'
import json, sys, datetime
from pathlib import Path
out, app, version = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
meta = {
  "name": app,
  "version": version,
  "built_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "files": {
    "chrome_crx": f"{app}-chrome.crx",
    "chrome_zip": f"{app}-chrome.zip",
    "firefox_xpi": f"{app}-firefox.xpi",
    "chrome_crx_versioned": f"{app}-chrome-{version}.crx",
    "chrome_zip_versioned": f"{app}-chrome-{version}.zip",
    "firefox_xpi_versioned": f"{app}-firefox-{version}.xpi",
    "checksums": "SHA256SUMS",
  },
}
(out / "manifest.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
PY

PAGE_TEMPLATE="$ROOT/extension/build-page.html"
if [[ -f "$PAGE_TEMPLATE" ]]; then
  sed -e "s/__APP__/${APP}/g" -e "s/__VERSION__/${VERSION}/g" "$PAGE_TEMPLATE" > "$OUT/index.html"
fi

echo "built extensions into $OUT (version $VERSION)"
ls -la "$OUT"
