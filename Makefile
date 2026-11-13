# Local entry points for the backup window application. CI runs `verify` and
# `test`, one step per target.
#
# The artifact is built by the pack entry, which goes through the kos-sdk
# packer; the browser-side data surface and its acceptance cases run under the
# Node test runner, because the window is UI-only and has no server of its own.
#
# Nothing here pushes or publishes: the repository is the delivery.

SHELL := /bin/sh
GO ?= go
NODE ?= node
DIST ?= dist

.PHONY: all build package verify fmt-check vet js-check lint go-test js-test test acceptance clean

all: verify test

build: package

# package writes the artifact an install request names and prints its digest.
package:
	$(GO) run ./cmd/kos-backup-pack -out $(DIST)

verify: fmt-check vet js-check

fmt-check:
	@unformatted=$$(gofmt -l $$(git ls-files '*.go')); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt required for:"; echo "$$unformatted"; exit 1; \
	fi

vet:
	$(GO) vet ./...

# js-check parses every module the window loads and every case, so a syntax
# error is caught here rather than in a browser console.
js-check:
	@for file in $$(git ls-files '*.js'); do $(NODE) --check "$$file" || exit 1; done

lint: verify

go-test:
	$(GO) test ./...

js-test:
	$(NODE) --test tests/acceptance/*/*.test.js

test: go-test js-test

acceptance: js-test
	$(GO) test ./tests/... -count=1 -v

clean:
	rm -rf $(DIST)
