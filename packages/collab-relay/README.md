# jeopi-collab-relay

Self-hostable production relay for [jeopi collab live sessions](../../docs/collab.md). Implements the full content-blind contract `collab.relayUrl` / `share.serverUrl` expect — WebSocket room forwarding, the `/share` blob store, and serving the `jeopi-collab-web` guest client — behind one Bun server. Not the default (jeopi currently defaults to the upstream `wss://my.omp.sh` relay) — deploy this and point `collab.relayUrl`/`share.serverUrl` at it if you want to self-host instead.

## Routes

| Route | Method | Effect |
|---|---|---|
| `/` (and any non-API path) | `GET` | Static `jeopi-collab-web` SPA, `index.html` fallback for client-side routes |
| `/r/<roomId>?role=host\|guest` | `GET` (upgrade) | WebSocket room forwarding — see `src/rooms.ts` |
| `/s` | `POST` | Upload a sealed share blob → `{ id }` |
| `/s/<id>` | `GET` | Share viewer page (id-agnostic HTML; the id is read client-side from the URL) |
| `/s/<id>/raw` | `GET` | Raw sealed blob bytes (`application/octet-stream`) |
| `/healthz` | `GET` | Liveness (`200 ok`) |

Every session payload arrives pre-sealed (AES-256-GCM) by the host/guest — this process only ever touches ciphertext plus the plaintext 4-byte peerId envelope prefix used for routing (see `docs/collab.md` §End-to-end encryption).

## Quick start

```sh
# from the repo root
bun --cwd=packages/collab-relay run build   # builds collab-web SPA + share-viewer.html into dist/web
bun --cwd=packages/collab-relay run start   # or: bun run dev (build + start in one)
```

Point a jeopi instance at it:

```
/collab ws://localhost:8787
```

or set `collab.relayUrl` / `share.serverUrl` in `/settings` for a standing deployment.

## Configuration

All env vars are optional — the server runs with zero configuration for local use.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | TCP port to bind (most PaaS providers inject this) |
| `HOST` | `0.0.0.0` | Bind hostname |
| `RELAY_WEB_ROOT` | `dist/web` | Directory the built SPA + share-viewer.html live in |
| `RELAY_DATA_DIR` | `.data` | Directory sealed share blobs persist to (mount a volume for durability) |
| `RELAY_SHARE_MAX_BYTES` | `1000000` | Hard cap on an uploaded share blob (mirrors coding-agent's client-side cap) |
| `RELAY_SHARE_TTL_DAYS` | `30` | Share blobs older than this are swept by the periodic GC pass |
| `RELAY_SHARE_GC_INTERVAL_MIN` | `60` | How often the GC sweep runs |
| `RELAY_MAX_ROOMS` | `10000` | Max live rooms at once; a new host beyond this gets `503` |
| `RELAY_MAX_GUESTS_PER_ROOM` | `32` | Max guests per room; a joining guest beyond this is closed with `4008` |
| `RELAY_WS_MAX_PAYLOAD_BYTES` | `50331648` (48 MiB) | WebSocket per-message cap — must cover a base64 inline image plus JSON/seal overhead |
| `RELAY_WS_IDLE_TIMEOUT_SEC` | `180` | Seconds of silence before a websocket is closed (Bun's uWebSockets backend pings at the protocol level, so a live-but-quiet session stays open) |

## Deploying

```sh
docker build -f packages/collab-relay/Dockerfile -t jeopi/collab-relay:dev .
docker run --rm -p 8787:8787 -v collab-relay-data:/data -e RELAY_DATA_DIR=/data jeopi/collab-relay:dev
```

Build from the **repo root** (not this directory) — the Dockerfile needs the monorepo workspace to resolve `jeopi-wire`, build `collab-web`, and run coding-agent's `gen:share-viewer` script. The runtime image ships only the built static site and relay source, no dev toolchain.

Any platform that runs a long-lived Bun/Node process with a persistent volume works: bind `RELAY_DATA_DIR` to a volume so share blobs survive restarts/redeploys, and put it behind TLS (WebCrypto — which the collab-web client and viewer rely on — requires a secure context or `localhost`).

## Architecture

- `src/config.ts` — env-driven config, one function, zero required vars.
- `src/rooms.ts` — `RoomManager`: envelope-routing WebSocket room forwarding (host authoritative, guests never peer), hardened over `collab-web/scripts/local-relay.ts`'s dev-only version with `maxRooms`/`maxGuestsPerRoom` capacity limits.
- `src/share-store.ts` — `ShareStore`: disk-backed `/share` blob storage with a size cap, TTL-based GC sweep, and id generation that always lands outside the client's pure-hex GitHub-gist-routing shape.
- `src/static.ts` — SPA static file serving with `index.html` fallback for client-side routes.
- `src/server.ts` — wires the above into one `Bun.serve` (HTTP + WebSocket), exported as `startRelayServer(overrides?)` for tests and the `import.meta.main` CLI entry.
- `scripts/build.ts` — production build: runs `collab-web`'s own build, then coding-agent's `gen:share-viewer` script, and lays both out under `dist/web`.

## Relation to `collab-web`'s `scripts/local-relay.ts`

That script is `collab-web`'s dev-only offline relay stand-in (used by `bun run mock-host` and its own test suite) — no share endpoints, no capacity limits, no persistence. This package is the production counterpart: same wire-forwarding contract, plus everything a real deployment needs.
