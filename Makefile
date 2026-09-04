# speakasm offline browser Kokoro TTS via ONNX WASM
#
# Targets:
#   make assets      download ONNX model + voices + vendor JS (once)
#   make build       compile server
#   make run         run on :8080
#   make test        go + js tests
#   make lint        golangci-lint
#   make sec         gosec + govulncheck
#   make check       test + lint + sec

APP        := speakasm
MODULE     := github.com/Quad4-Software/speakasm
CMD        := ./cmd/speakasm
BIN_DIR    := bin
BIN        := $(BIN_DIR)/$(APP)
GO         ?= go
GOFLAGS    ?=
LDFLAGS    ?= -s -w -X $(MODULE)/internal/version.Version=$(VERSION)
VERSION    ?= 0.1.0

GOLANGCI_LINT ?= golangci-lint
GOSEC         ?= gosec
GOVULNCHECK   ?= govulncheck
STATICCHECK   ?= staticcheck
GOIMPORTS     ?= goimports
NODE          ?= node

.PHONY: all assets build run test test-go test-js lint sec check fmt vet staticcheck clean help

all: assets build

help:
	@printf '%s\n' \
		'assets        fetch offline Kokoro ONNX/voices/fonts/vendor' \
		'build         compile $(BIN)' \
		'run           ensure assets then serve :8080' \
		'test          go test + node tests' \
		'lint          golangci-lint run' \
		'sec           gosec + govulncheck' \
		'check         test + lint + sec' \
		'clean         remove bin/'

assets:
	@bash scripts/fetch-assets.sh

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

build: $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) $(CMD)

run: assets build
	$(BIN) -web web -addr :8080

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

clean:
	rm -rf $(BIN_DIR)
