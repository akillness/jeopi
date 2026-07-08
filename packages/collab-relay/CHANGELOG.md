# Changelog

## [Unreleased]

### Added

- Initial release: a self-hostable production relay implementing the full `docs/collab.md` contract — WebSocket room forwarding (`src/rooms.ts`, hardened over `collab-web`'s dev-only `local-relay.ts` with `maxRooms`/`maxGuestsPerRoom` capacity limits), a disk-backed `/share` blob store with size cap + TTL GC sweep (`src/share-store.ts`), static serving of the built `collab-web` SPA with `index.html` fallback (`src/static.ts`), and `GET /healthz`. `scripts/build.ts` builds `collab-web` and generates the standalone share-viewer page into one deployable `dist/web`. Not wired up as jeopi's default relay (that stays the upstream `wss://my.omp.sh` for now) — deploy this and point `collab.relayUrl`/`share.serverUrl` at it to self-host instead.

### Fixed

- `Dockerfile` failed to build standalone (workspace not found, missing `patches/*.patch`, stale `bun.lock`, and `Cannot find package 'jeopi-natives'`): the multi-package `bun install` needs every workspace's `package.json` in the build context (including `python/robomp/web`, declared in root `package.json`'s `workspaces`) plus `patches/*.patch` for `patchedDependencies`; `coding-agent`'s share-viewer generator transitively imports `theme.ts`, which top-level-imports `jeopi-natives` for syntax highlighting even though only its pure color-computation exports are used — the workspace symlink shadows npm's prebuilt `jeopi-natives-linux-x64` optional dependency, so a `natives-builder` Rust stage (mirroring the root `Dockerfile`'s recipe) now compiles the addon and stages it at `packages/natives/native/`, the exact path the loader's `nativeDir` resolves to. Verified end to end against a live Fly.io deployment: `/healthz`, `/`, `POST /s` → `GET /s/<id>/raw` → `GET /s/<id>`, and a real `wss://` WebSocket room round-trip all confirmed working in production.
