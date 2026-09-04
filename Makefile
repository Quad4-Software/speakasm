# speakasm offline browser Kokoro TTS via ONNX WASM
#
# Targets:
#   make assets      download ONNX model + voices + vendor JS (once)
#   make build       compile server
#   make run         run on :8080
#   make docker      build local container image (full offline assets)
#   make docker-push buildx push to GHCR (linux/amd64,linux/arm64)
#   make badges      regenerate themed shields.io endpoint JSON
#   make test        go + js tests
#   make lint        golangci-lint
#   make sec         gosec + govulncheck
#   make check       test + lint + sec
#   make screenshots capture UI PNGs into docs/screenshots (needs server or SPEAKASM_URL)

APP        := speakasm
MODULE     := github.com/Quad4-Software/speakasm
CMD        := ./cmd/speakasm
BIN_DIR    := bin
BIN        := $(BIN_DIR)/$(APP)
GO         ?= go
GOFLAGS    ?=
LDFLAGS    ?= -s -w -X $(MODULE)/internal/version.Version=$(VERSION)
VERSION    ?= 0.1.0
IMAGE      ?= ghcr.io/quad4-software/$(APP):$(VERSION)
PLATFORMS  ?= linux/amd64,linux/arm64

GOLANGCI_LINT ?= golangci-lint
GOSEC         ?= gosec
GOVULNCHECK   ?= govulncheck
STATICCHECK   ?= staticcheck
GOIMPORTS     ?= goimports
NODE          ?= node
NPM           ?= npm
SPEAKASM_URL  ?= http://127.0.0.1:8080
SHOT_DIR      := scripts/screenshots

.PHONY: all assets build run docker docker-push badges test test-go test-js lint sec check fmt vet staticcheck screenshots stamp-sw clean help

all: assets build

help:
	@printf '%s\n' \
		'assets        fetch offline Kokoro ONNX/voices/fonts/vendor (scripts/fetch-assets.sh [--shell])' \
		'stamp-sw      set SHELL_VERSION in web/sw.js (SHELL_VERSION=... or git sha)' \
		'build         compile $(BIN)' \
		'run           ensure assets then serve :8080' \
		'docker        build $(IMAGE) with full offline assets' \
		'docker-push   buildx push $(IMAGE) for $(PLATFORMS)' \
		'badges        regenerate themed shields endpoint JSON' \
		'test          go test + node tests' \
		'lint          golangci-lint run' \
		'sec           gosec + govulncheck' \
		'check         test + lint + sec' \
		'screenshots   Playwright PNGs into docs/screenshots (SPEAKASM_URL=$(SPEAKASM_URL))' \
		'clean         remove bin/'

stamp-sw:
	@SHELL_VERSION="$${SHELL_VERSION:-$(VERSION)}"; \
	if [ -z "$$SHELL_VERSION" ] || [ "$$SHELL_VERSION" = "0.1.0" ]; then \
	  SHELL_VERSION=$$(git rev-parse --short=12 HEAD 2>/dev/null || echo dev); \
	fi; \
	sed -i "s/const SHELL_VERSION = '[^']*'/const SHELL_VERSION = '$$SHELL_VERSION'/" web/sw.js; \
	printf 'stamped SHELL_VERSION=%s\n' "$$SHELL_VERSION"

assets:
	@bash scripts/fetch-assets.sh

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

build: $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) $(CMD)

run: assets build
	$(BIN) -web web -addr :8080

docker:
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$$(git rev-parse HEAD 2>/dev/null || echo local) \
		--build-arg CREATED=$$(date -u +%Y-%m-%dT%H:%M:%SZ) \
		-t $(IMAGE) \
		-t $(APP):$(VERSION) \
		.

docker-push:
	docker buildx build \
		--platform $(PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$$(git rev-parse HEAD 2>/dev/null || echo local) \
		--build-arg CREATED=$$(date -u +%Y-%m-%dT%H:%M:%SZ) \
		-t $(IMAGE) \
		-t ghcr.io/quad4-software/$(APP):latest \
		--push \
		.

badges:
	@VERSION=$(VERSION) bash scripts/gen-badges.sh

test-go:
	$(GO) test $(GOFLAGS) ./...

test-js:
	$(NODE) --test web/js/text/clean.test.mjs

test: test-go test-js

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...
	@if command -v $(GOIMPORTS) >/dev/null 2>&1; then \
		$(GOIMPORTS) -w $$(find . -name '*.go' -not -path './vendor/*' -not -path './scripts/vendor/*'); \
	fi

lint:
	$(GOLANGCI_LINT) run ./...

staticcheck:
	$(STATICCHECK) ./...

sec:
	$(GOSEC) -quiet ./...
	$(GOVULNCHECK) ./...

check: test vet lint sec

screenshots:
	@cd $(SHOT_DIR) && $(NPM) install --no-fund --no-audit
	@cd $(SHOT_DIR) && $(NPM) exec -- playwright install chromium
	@SPEAKASM_URL='$(SPEAKASM_URL)' $(NODE) $(SHOT_DIR)/capture.mjs

clean:
	rm -rf $(BIN_DIR)
