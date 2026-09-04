# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Multi-stage rootless image for speakasm.
# Base digests pinned to multi-arch OCI indexes (Alpine 3.24 / Go 1.26-alpine).

ARG ALPINE_DIGEST=sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b
ARG GOLANG_DIGEST=sha256:ce864e7223ac17b1775e6fd0b4c0db580c2eb50e7953a427916379e4b92a1628
ARG VERSION=0.1.0
ARG REVISION=unknown
ARG CREATED=unknown

FROM golang:1.26-alpine@${GOLANG_DIGEST} AS builder

ARG VERSION
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

ENV CGO_ENABLED=0
RUN --mount=type=cache,target=/root/.cache/go-build \
	--mount=type=cache,target=/go/pkg/mod \
	GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
	go build \
		-trimpath \
		-buildvcs=false \
		-ldflags="-s -w -X github.com/Quad4-Software/speakasm/internal/version.Version=${VERSION}" \
		-o /out/speakasm \
		./cmd/speakasm

FROM node:22-alpine AS vendor

WORKDIR /src
COPY scripts/vendor/package.json ./scripts/vendor/
COPY scripts/vendor-kokoro.sh ./scripts/vendor-kokoro.sh
RUN apk add --no-cache bash curl python3 \
	&& mkdir -p web/vendor/kokoro web/vendor/jszip \
	&& bash scripts/vendor-kokoro.sh

FROM alpine:3.24@${ALPINE_DIGEST} AS models

RUN apk add --no-cache curl \
	&& mkdir -p /models/Kokoro-82M-v1.0-ONNX/onnx /models/Kokoro-82M-v1.0-ONNX/voices /fonts

ARG HF=https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main

RUN curl -L --fail --retry 5 --retry-delay 2 -o /models/Kokoro-82M-v1.0-ONNX/config.json "$HF/config.json" \
	&& curl -L --fail --retry 5 --retry-delay 2 -o /models/Kokoro-82M-v1.0-ONNX/tokenizer.json "$HF/tokenizer.json" \
	&& curl -L --fail --retry 5 --retry-delay 2 -o /models/Kokoro-82M-v1.0-ONNX/tokenizer_config.json "$HF/tokenizer_config.json" \
	&& curl -L --fail --retry 5 --retry-delay 2 -o /models/Kokoro-82M-v1.0-ONNX/onnx/model_quantized.onnx "$HF/onnx/model_quantized.onnx"

RUN for voice in af_heart af_bella af_sarah af_nicole af_nova af_sky am_adam am_michael am_fenrir am_puck bf_emma bf_isabella bm_george bm_lewis; do \
	curl -L --fail --retry 5 --retry-delay 2 \
		-o /models/Kokoro-82M-v1.0-ONNX/voices/${voice}.bin \
		"$HF/voices/${voice}.bin"; \
	done

RUN curl -L --fail --retry 5 --retry-delay 2 \
		-o /fonts/bricolage-700.woff2 \
		"https://cdn.jsdelivr.net/fontsource/fonts/bricolage-grotesque@5.2.8/latin-700-normal.woff2" \
	&& curl -L --fail --retry 5 --retry-delay 2 \
		-o /fonts/source-sans-400.woff2 \
		"https://cdn.jsdelivr.net/fontsource/fonts/source-sans-3@5.2.8/latin-400-normal.woff2" \
	&& curl -L --fail --retry 5 --retry-delay 2 \
		-o /fonts/source-sans-600.woff2 \
		"https://cdn.jsdelivr.net/fontsource/fonts/source-sans-3@5.2.8/latin-600-normal.woff2"

FROM alpine:3.24@${ALPINE_DIGEST} AS runtime

ARG VERSION
ARG REVISION
ARG CREATED
ARG ALPINE_DIGEST
ARG GOLANG_DIGEST

LABEL org.opencontainers.image.title="speakasm" \
	org.opencontainers.image.description="Offline in-browser Kokoro text-to-speech via ONNX" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.revision="${REVISION}" \
	org.opencontainers.image.created="${CREATED}" \
	org.opencontainers.image.licenses="0BSD" \
	org.opencontainers.image.vendor="speakasm" \
	org.opencontainers.image.source="https://github.com/Quad4-Software/speakasm" \
	org.opencontainers.image.url="https://speakasm.quad4.io" \
	org.opencontainers.image.documentation="https://github.com/Quad4-Software/speakasm" \
	org.opencontainers.image.base.name="docker.io/library/alpine:3.24" \
	org.opencontainers.image.base.digest="${ALPINE_DIGEST}" \
	org.opencontainers.image.ref.name="speakasm:${VERSION}"

RUN apk upgrade --no-cache \
	&& addgroup -g 65532 -S nonroot \
	&& adduser -u 65532 -S -D -H -G nonroot nonroot \
	&& mkdir -p /app/web/models \
	&& chown -R nonroot:nonroot /app

COPY --from=builder --chown=nonroot:nonroot /out/speakasm /app/speakasm
COPY --chown=nonroot:nonroot web /app/web
COPY --from=vendor --chown=nonroot:nonroot /src/web/vendor/ /app/web/vendor/
COPY --from=models --chown=nonroot:nonroot /models/ /app/web/models/
COPY --from=models --chown=nonroot:nonroot /fonts/ /app/web/fonts/

RUN chmod 0555 /app/speakasm \
	&& chmod -R a-w /app/web

ENV SPEAKASM_ADDR=":8080" \
	SPEAKASM_WEB="/app/web" \
	HOME="/tmp"

WORKDIR /app
USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD wget -q -O /dev/null http://127.0.0.1:8080/api/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/app/speakasm"]
CMD ["-addr", ":8080", "-web", "/app/web"]
