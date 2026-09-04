# speakasm

Offline text-to-speech in the browser via [Kokoro-82M](https://github.com/hexgrad/kokoro) ONNX. Nothing is uploaded.

**Live:** [https://speakasm.quad4.io](https://speakasm.quad4.io)

Kokoro weights (`web/models/`, ~95MB q8) and the vendored JS runtime are **not** in git. Docker and Pages fetch them at build time. For a local source build, run `make assets` once.

Kokoro (82M, official browser ONNX via Transformers.js) was chosen over Pocket TTS for a lighter in-browser footprint and first-party WASM/WebGPU support. See [kokorottsai.com](https://kokorottsai.com/) and the [hexgrad/kokoro](https://github.com/hexgrad/kokoro) repo.

## Install (Docker)

```bash
git clone git@github.com:Quad4-Software/speakasm.git
cd speakasm
docker compose up --build
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080).

Coolify: use `docker-compose.coolify.yml` and set the domain to container port `8080`.

## Build from source

Needs Go 1.26+, Node (for vendoring kokoro-js), and curl.

```bash
git clone git@github.com:Quad4-Software/speakasm.git
cd speakasm
make assets
make build
make run
```

```bash
make test
make check
```

Binary: `bin/speakasm` (default listen `:8080`, web root `web`).

## Features

- Paste text or open TXT, Markdown, HTML, EPUB, DOCX
- Automatic cleanup of markup, nav junk, and ebook boilerplate
- Multiple Kokoro voices (US/UK)
- Speed control, streaming playback, WAV download
- Fully local after `make assets` / first offline save
- PWA install + service worker caching

## License

0BSD
