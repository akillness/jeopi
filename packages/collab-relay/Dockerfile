# syntax=docker/dockerfile:1.7-labs
###############################################################################
# jeopi collab relay — self-hostable production replacement for my.omp.sh
#
# Build (from repo root, so the monorepo workspace resolves):
#     docker build -f packages/collab-relay/Dockerfile -t jeopi/collab-relay:dev .
#
# Run:
#     docker run --rm -p 8787:8787 -v collab-relay-data:/data \
#       -e RELAY_DATA_DIR=/data jeopi/collab-relay:dev
###############################################################################

ARG BUN_VERSION=1.3.14

############################
# 1) natives-builder — Rust + Bun → pi_natives.linux-<arch>.node
#
# `theme.ts` (pulled in by coding-agent's share-viewer generator) imports
# `jeopi-natives` at module top-level for syntax highlighting, even though
# the relay only ever calls the pure color-computation exports. The
# workspace symlink (`node_modules/jeopi-natives` → `packages/natives`)
# shadows npm's prebuilt `jeopi-natives-linux-x64` optional dependency, so
# the addon has to be compiled here — same recipe as the root Dockerfile.
############################
FROM rust:1.86-slim-bookworm AS natives-builder

ARG BUN_VERSION
ENV BUN_INSTALL=/opt/bun \
	PATH=/opt/bun/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin \
	CARGO_TERM_COLOR=never

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		curl ca-certificates pkg-config libssl-dev unzip git \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
	&& /opt/bun/bin/bun --version

WORKDIR /pi

COPY --parents \
	package.json bun.lock bunfig.toml \
	patches/*.patch \
	tsconfig.base.json tsconfig.json \
	Cargo.toml Cargo.lock rust-toolchain.toml \
	packages/*/package.json \
	packages/tsconfig.workspace.json \
	python/robomp/web/package.json \
	crates/*/Cargo.toml \
	/pi/

RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/natives packages/natives
COPY crates crates
COPY scripts/host-detect.ts scripts/host-detect.ts

RUN --mount=type=cache,target=/root/.cargo/registry \
	--mount=type=cache,target=/root/.cargo/git \
	--mount=type=cache,target=/pi/target \
	set -eux; \
	rustup show; \
	bun --cwd=packages/natives run build; \
	mkdir -p /out; \
	cp packages/natives/native/pi_natives.linux-*.node /out/

############################
# 2) builder — assembles the relay + its share-viewer generator dependencies
############################
FROM oven/bun:${BUN_VERSION}-slim AS builder
WORKDIR /pi

# Layer 1 — manifests + lockfiles only, so `bun install` only re-runs when a
# package.json/lockfile changes, not on every source edit.
COPY --parents \
	package.json bun.lock bunfig.toml \
	patches/*.patch \
	tsconfig.base.json tsconfig.json \
	packages/*/package.json \
	packages/tsconfig.workspace.json \
	python/robomp/web/package.json \
	/pi/

RUN bun install --frozen-lockfile --ignore-scripts

# Layer 2 — full source needed to build the relay: itself, collab-web (SPA),
# wire (shared protocol types), and coding-agent's share-viewer generator +
# its own template/export dependencies.
COPY packages/collab-relay packages/collab-relay
COPY packages/collab-web packages/collab-web
COPY packages/wire packages/wire
COPY packages/coding-agent packages/coding-agent
COPY packages/ai packages/ai
COPY packages/agent packages/agent
COPY packages/catalog packages/catalog
COPY packages/utils packages/utils
COPY packages/tui packages/tui
COPY packages/hashline packages/hashline
COPY packages/snapcompact packages/snapcompact
COPY packages/natives packages/natives

# Layer 3 — compiled native addon from stage 1. Placed at
# packages/natives/native/, the exact path the loader's `nativeDir`
# resolves to (import.meta.dir of native/index.js), so the workspace
# symlink `node_modules/jeopi-natives` finds it with no extra staging.
COPY --from=natives-builder /out/pi_natives.linux-*.node packages/natives/native/

RUN bun --cwd=packages/collab-relay run build

############################
# Runtime — only the built static site + relay source, no dev toolchain.
############################
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV PORT=8787 \
	HOST=0.0.0.0 \
	RELAY_DATA_DIR=/data \
	RELAY_WEB_ROOT=/app/dist/web

COPY --from=builder /pi/packages/collab-relay/src ./src
COPY --from=builder /pi/packages/collab-relay/dist/web ./dist/web
# jeopi-wire is a workspace symlink in the builder's node_modules; vendor the
# real source + package.json here instead of copying the (now-dangling) link.
COPY --from=builder /pi/packages/wire/package.json ./node_modules/jeopi-wire/package.json
COPY --from=builder /pi/packages/wire/src ./node_modules/jeopi-wire/src

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
	CMD bun -e 'fetch(`http://localhost:${process.env.PORT}/healthz`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

ENTRYPOINT ["bun", "src/server.ts"]
