# Development targets. The package is built against a local checkout of xcl,
# XCL_SRC, from which the CoreService messages are generated and the engine
# and fixture plugins are built. A release uses the signed engine archives from
# the xcl release instead, see .github/workflows/release.yml.
XCL_SRC ?= ../xcl

# ENGINE_VERSION is the engine version the package checks for, from
# src/version.ts; a development engine is stamped with it so the version check
# passes.
ENGINE_VERSION := $(shell node -p "/ENGINE_VERSION = \"([^\"]+)\"/.exec(require('fs').readFileSync('src/version.ts','utf8'))[1]")
EXE := $(shell node -p "process.platform === 'win32' ? '.exe' : ''")

# protos generates the message classes of CoreService and of the engine
# program's frames from the xcl checkout. They are committed, and regenerating
# them from the tag in xcl-ref.txt changes nothing.
protos:
	npx buf generate "$(XCL_SRC)/proto" --template buf.gen.yaml --path "$(XCL_SRC)/proto/xcl/core/v1/core.proto" --path "$(XCL_SRC)/proto/xcl/core/v1/transport.proto"

# engine builds the engine program from the xcl checkout for the local
# platform, stamped with ENGINE_VERSION. It needs Go and no C compiler. Point
# XCL_CORE_PATH at the result to run the package against it.
engine:
	mkdir -p build/engine
	$(MAKE) -C "$(XCL_SRC)" xcl-core XCL_CORE_VERSION=$(ENGINE_VERSION) XCL_CORE_OUT="$(CURDIR)/build/engine/xcl-core$(EXE)"

# plugins builds the fixture plugins the integration tests use, and the Go
# parity program, into build/plugins, with the platform's executable suffix.
plugins:
	mkdir -p build/plugins
	cd "$(XCL_SRC)/bindings/libxcl" && go build -o "$(CURDIR)/build/plugins/xcl-plugin-slow$(EXE)" ./testdata/plugins/slow && go build -o "$(CURDIR)/build/plugins/xcl-plugin-recording$(EXE)" ./testdata/plugins/recording && go build -o "$(CURDIR)/build/plugins/parity$(EXE)" ./cmd/parity

# test runs every suite; the integration and parity suites need make engine
# and make plugins, and XCL_SRC to find the fixtures. test-unit needs no engine.
test:
	XCL_CORE_PATH="$${XCL_CORE_PATH:-$(CURDIR)/build/engine/xcl-core$(EXE)}" XCL_SRC="$(abspath $(XCL_SRC))" npm test

test-unit:
	npm run test:unit

.PHONY: protos engine plugins test test-unit
