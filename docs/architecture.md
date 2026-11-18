# PacketManager — HTTP server architecture

How the Candyriya packet manager HTTP server is put together: what it serves, how a request travels from the socket to disk and back, how plugin bundles are stored and validated, where the trust boundaries are, and how the single binary is deployed. A reference for people reading or extending `src/`.

## Contents

1. [What the server does](#1-what-the-server-does)
2. [Request flow](#2-request-flow)
3. [Module responsibilities](#3-module-responsibilities)
4. [Storage: `$PM_DATA_DIR` layout](#4-storage-pm_data_dir-layout)
5. [The `.plugin` bundle and the publish-validation pipeline](#5-the-plugin-bundle-and-the-publish-validation-pipeline)
6. [Listings, health and metrics](#6-listings-health-and-metrics)
7. [Security posture](#7-security-posture)
8. [The operator-facing index (phase 1 note)](#8-the-operator-facing-index-phase-1-note)
9. [Deployment](#9-deployment)
10. [Modules that do not exist yet](#10-modules-that-do-not-exist-yet)
11. [Decisions recorded in this document](#11-decisions-recorded-in-this-document)
12. [System-wide risks](#12-system-wide-risks)

## 1. What the server does

`packetmanager` is a public, read-mostly registry for signed Candyriya plugin bundles. Phase 1 ships exactly these surfaces:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | liveness — process is up |
| `GET` | `/ready` | none | readiness — index built, data dir readable |
| `GET` | `/metrics` | none (network-ACL recommended) | Prometheus exposition |
| `GET` | `/api/v1/plugins` | none | list published plugins (summary) |
| `GET` | `/api/v1/plugins/:id` | none | plugin detail (all versions) |
| `GET` | `/api/v1/plugins/:id/download` | none | `.plugin` bytes; `?version=x.y.z`, default latest semver |
| `POST` | `/api/v1/plugins/publish` | `x-api-key` | publish a `.plugin` bundle (binary body) |

The read API is the product: the CLI and human consumers resolve, download and verify plugins through it. The publish endpoint is a single-purpose, API-key-guarded path for a small set of publishers. There is no Web UI and no operator console. Bundles are immutable once published — re-publishing the same `id@version` is rejected with `409`.

Detail responses are shaped like this (frozen for `v1`, additive only):

```json
{ "ok": true, "data": { "id": "candyriya.example", "name": "Example Plugin",
    "license": "MIT", "website": "https://example.org",
    "versions": [ { "version": "1.4.0", "api": "0.1", "size": 12345,
                    "sha256": "…", "publisher": "<kid>", "publishedAt": "…" } ] } }
```

`GET /api/v1/plugins` returns `data: { plugins: [...] }` with the same per-version entries minus the payload-adjacent fields. Download URLs pin an immutable version, so proxies and the CLI may cache aggressively.

All responses use one envelope. Success: `{ "ok": true, "data": ... }`. The `/api/v1` prefix is the compatibility contract: additive fields may appear in `data` at any time; breaking changes are a new prefix. Consumers must ignore fields they do not know. Failure: `{ "ok": false, "error": { "code", "message" } }` with a stable `code` (`invalid_bundle`, `bad_signature`, `duplicate_version`, `unauthorized`, `not_found`, `rate_limited`, `unsupported_api`, `internal`). Status map: `200` reads · `201` publish accepted · `400` malformed bundle or bad signature · `401` missing/wrong key · `403` publisher key unknown/revoked · `404` unknown id or version · `409` duplicate version · `413` body too large · `415` wrong content type · `422` unsupported plugin API level · `429` rate limited (with `Retry-After`) · `500` internal · `503` not ready. `/metrics` is the only non-envelope endpoint.

## 2. Request flow

```text
client (CLI / curl)
   |  HTTPS
   v
reverse proxy (nginx / caddy)  -- TLS termination, ACL on /metrics
   |  plain HTTP on 127.0.0.1:8093
   v
src/index.ts  -- composition root: env config (src/config.ts), wires registry, starts Elysia
   |
   |-- src/ratelimit.ts     per-IP token buckets (read and publish limiters)
   |-- src/http-metrics.ts  request counter + duration histogram
   v
router (Elysia)
   |-- GET  /health, /ready, /metrics          --> handlers, no auth, no storage read
   |-- GET  /api/v1/plugins[/:id[/download]]   --> src/routes/plugins.ts (no auth)
   |        v
   |      src/registry.ts  -- in-memory index: summaries, details, sha256/ETag;
   |                          download streams the bundle file from disk
   |-- POST /api/v1/plugins/publish            --> src/auth.ts (x-api-key, constant-time)
   |        v
   |      src/plugin-format.ts  -- envelope + manifest + sha256 + ed25519 verify
   |        v
   |      src/publisher-keys.ts -- keys/publishers/ + revocations.json (read per publish)
   |        v
   |      src/registry.ts  -- stage in tmp/, fsync, rename into plugins/<id>/<version>/
   |        v
   |      src/audit.ts     -- append JSONL to audit.log (fsync before the 201 is sent)
   |        v
   |      response
```

Stage order is deliberate. Rate limiting runs before routing so unauthenticated floods never reach the parser. Publish auth runs before the body is read so the server never spends parser CPU on unauthorized input. Everything is validated in memory first; nothing is written to `plugins/` until the whole pipeline passes.

**Startup sequence.** `src/index.ts` in order: parse and validate env (`src/config.ts` — any invalid value is fatal) → assert `PM_API_KEY` is set (fatal otherwise) → read `keys/publishers/` (missing directory is legal: publishing will reject every signature with `403`, reads still work) → scan `plugins/` header-only, skip-and-warn on invalid entries (publishing-quality problems are logged, never fatal to reads) → write derived `index.json` → `listen`. `/ready` stays `503` until the scan completes; a scan failure is fatal at startup — booting a registry that cannot truthfully list its contents is worse than crashing.

## 3. Module responsibilities

**Existing modules (bootstrap, reworked in place):**

- `src/index.ts` — composition root and CLI entry. Parses env via `src/config.ts`, constructs the registry, builds the Elysia app, calls `listen`. Wiring only — no validation, no storage logic. Fails fast (exit non-zero) when `PM_API_KEY` is unset; the bootstrap's "open publish endpoint with a warning" behaviour is removed.
- `src/auth.ts` — the publish guard. Constant-time comparison (`crypto.timingSafeEqual`) of `x-api-key` against the configured key. Applies to exactly one path (`/api/v1/plugins/publish`); read routes never consult it. Never logs or echoes the key.
- `src/registry.ts` — storage and index. Builds the in-memory index by scanning `plugins/` at startup, serves list/detail from memory, streams download bytes from disk, performs atomic publishes (`tmp/` + rename), rejects duplicate versions, rewrites derived `index.json` at startup and after every publish.

**Added as the server grows (phase 1):**

- `src/config.ts` — env parsing/validation: `PORT`, `PM_DATA_DIR`, `PM_API_KEY`, `PM_BASE_URL`, `PM_ACCEPTED_API`, `PM_MAX_BUNDLE_BYTES`, `PM_RATE_READ_PER_MIN`, `PM_RATE_PUBLISH_PER_MIN`. Unknown values fail startup with a readable message; secrets are never printed.
- `src/routes/plugins.ts` — HTTP handlers for list/detail/download/publish. Handlers own status codes and the envelope; decisions are delegated (registry, auth, plugin-format). `:id` is matched against the id grammar before any disk access.
- `src/plugin-format.ts` — `.plugin` envelope parser/validator (magic, version, manifest schema, sha256, ed25519). Pure functions, no I/O.
- `src/publisher-keys.ts` — publisher public-key loading from `keys/publishers/`, revocation checks against `revocations.json`. Read fresh from disk on every publish (rare op), so revoking a publisher needs no restart.
- `src/ratelimit.ts` — in-memory per-IP token buckets, one for reads, one for publish. Single-instance state; `429` + `Retry-After` when exhausted.
- `src/audit.ts` — append-only JSONL audit log; every publish attempt (accepted or rejected) is recorded with timestamp, id, version, key id, sha256 and outcome. A publish whose audit line cannot be fsynced fails with `500` — an unaudited publish never succeeds.
- `src/http-metrics.ts` — request counting/duration plus the domain metrics in [§6](#6-listings-health-and-metrics); Prometheus exposition.
- `src/index-file.ts` — deterministic `index.json` serialization (sorted keys, sorted plugin list, trailing newline) so the derived index diffs cleanly and can be signed later.

Layering rule, same spirit as elsewhere in the project: leaves (format, keys, config) depend on nothing; `registry.ts` depends on leaves; routes depend on registry and guards; `index.ts` depends on everything and nothing depends on it.

**How this is tested.** `bun test` is green in CI and stays green. The shape follows the modules: `plugin-format.ts` is tested against byte-level fixtures (valid bundle, truncated envelope, wrong magic, oversized header, bad sha256, bad signature, unknown publisher, revoked kid) — all pure in-memory; `registry.ts` is tested against a fresh `PM_DATA_DIR` temp directory per case (no shared state, no network); the HTTP layer is tested through Elysia's `handle` against the real app with a temp data dir, so the publish pipeline is exercised end to end including the audit-write failure path. No test talks to the network and no test uses a real publisher private key from anywhere but a fixture generated in the test itself.

## 4. Storage: `$PM_DATA_DIR` layout

Decision for phase 1: **flat disk layout with a scan-at-startup index held in memory. No SQLite.** The registry is single-operator, append-mostly and tiny (hundreds of plugins, not millions); bundles are already the audit trail. A database buys nothing here and costs migrations, lock semantics and a second source of truth. `plugins/` on disk is the only source of truth; `index.json` is derived from it and regenerated, never edited.

```text
$PM_DATA_DIR/
├── plugins/                  # the only source of truth; one directory per plugin id
│   └── <id>/                 # plugin id, [a-z0-9_.-]{1,64} — e.g. candyriya.example
│       └── <version>/        # semver version directory, e.g. 1.4.0
│           └── plugin.plugin # the verbatim uploaded bundle; immutable once present
├── keys/
│   └── publishers/           # authorized publisher PUBLIC keys; private keys never live here
│       └── <kid>.pub         # ed25519 (SPKI PEM); filename without extension = key id (kid)
├── revocations.json          # {"keys": ["<kid>"], "bundles": ["<sha256>"]}; read per publish and per download
├── index.json                # derived, deterministic (sorted); rebuilt at startup and on publish; unsigned in phase 1
├── audit.log                 # append-only JSONL; fsync'd before a publish is acknowledged
└── tmp/                      # staging for atomic publish (random names); cleaned at startup; never served
```

Notes on the entries:

- `plugin.plugin` is stored **verbatim**. The server distributes files; it does not re-assemble them. Re-serialization on download would risk byte drift against the sha256 and signature publishers signed.
- Startup does a **header-only scan**: for each `plugins/<id>/<version>/plugin.plugin` it parses the fixed-size header + manifest (never the payload), checks the file's on-disk size against `manifest.size` (stat, no read), and builds the index. Payload bytes are never read at startup — boot cost is O(versions × header size), milliseconds even for large registries. `index.json` is rewritten on every startup and every publish.
- A deep integrity sweep (recompute every sha256) is an operator-run maintenance step, not a boot path — see [§10](#10-modules-that-do-not-exist-yet).
- The scan validates the directory grammar too: any `<id>` failing `[a-z0-9_.-]{1,64}` or any `<version>` failing strict semver is skipped with a warning, never served, never fatal. A bundle whose on-disk size differs from `manifest.size` is likewise skipped — serving a corrupted file while claiming the manifest's sha256 would be a lie by ETag.
- `index.json` is a cache of what was validated at publish time; the startup scan does not re-verify signatures (it would need to read every payload). Publish-time verification plus client-side sha256 checks cover the trust chain end to end.
- Bundle bytes are not cached in memory; the OS page cache serves hot reads. Downloads stream the file (`Content-Length` from `stat`).
- `tmp/` exists only inside a publish: write → fsync → `rename(2)` into the version directory. A crash mid-publish leaves a stray `tmp/` file the next startup deletes; `plugins/` never contains a partial bundle.
- `audit.log` grows unbounded; rotate with system logrotate. Rotating under a running server is fine — the server holds the fd.
- Backups: `$PM_DATA_DIR` is the entire state. Snapshot the directory while the server runs is safe enough because publishes are atomic renames; excluding `tmp/` keeps backups deterministic.
- `tmp/` lives inside `$PM_DATA_DIR` on purpose: `rename(2)` is only atomic within one filesystem. Staging in the OS temp dir and renaming into `plugins/` would silently degrade to a copy on a different mount — and a copy is not crash-safe. This is the one place the OS temp dir must not be used.

Derived `index.json` shape (the whole registry in a glance — this is what an operator inspects before something consumes it later):

```json
{ "generatedAt": "2026-01-01T00:00:00.000Z", "acceptedApi": ["0.1"],
  "plugins": [ { "id": "candyriya.example", "name": "Example Plugin",
                 "versions": [ { "version": "1.4.0", "sha256": "…", "size": 12345,
                                 "api": "0.1", "publisher": "<kid>", "publishedAt": "…" } ] } ] }
```

Keys and plugins are sorted; re-running the generator on identical input yields byte-identical output apart from `generatedAt`.

## 5. The `.plugin` bundle and the publish-validation pipeline

### 5.1 Bundle format (v1)

A `.plugin` file is a single-file bundle: a tiny fixed envelope, then the WASM payload. No compression, no container library — the format is defined here and parsed by `src/plugin-format.ts`.

```text
offset  size   field
0       4      magic: "CNPL" (0x43 0x4E 0x50 0x4C)
4       2      format version, uint16 LE — must be 1
6       2      header length N, uint16 LE — manifest byte size, ≤ 65536
8       N      manifest: UTF-8 JSON (schema below)
8+N     rest   payload: the WASM module bytes
```

Manifest schema:

```json
{
  "format": 1,
  "id": "candyriya.example",
  "name": "Example Plugin",
  "version": "1.4.0",
  "description": "Plain text, max 512 chars; no markup is rendered.",
  "authors": ["Some One"],
  "license": "MIT",
  "website": "https://example.org",
  "api": "0.1",
  "size": 12345,
  "sha256": "<64 lowercase hex — sha256 of the payload bytes>",
  "publisher": "<kid of the signing key>",
  "signature": "<base64 ed25519 signature over the payload bytes>"
}
```

Rules: `id` matches `[a-z0-9_.-]{1,64}`; `name` 1–128 printable chars, no control characters; `version` is strict semver (`major.minor.patch`, optional `-prerelease`, no build metadata); `api` must be in `PM_ACCEPTED_API`; `website`, if present, is `https://` only; `size` and `sha256` must match the actual payload; `signature` is ed25519 over the raw payload bytes (not the manifest, not the file). ed25519 signatures are 64 bytes — anything else is rejected before verification is attempted.

Verification mechanics: publisher keys are stored as SPKI PEM (`-----BEGIN PUBLIC KEY-----`, ed25519). Verification is a single unprefixed-hash call — `crypto.verify(null, payload, publicKey, signature)` — ed25519 has no parameterized digest. There is no key parsing from untrusted bytes beyond the SPKI load (which Bun/Node rejects cleanly on garbage), no signature malleability surface worth documenting (ed25519 is non-malleable for this purpose), and no timing-sensitive comparison in the publish path other than the API-key check. Key ids (`kid`s) are `[a-z0-9_.-]{1,64}` — the same grammar as plugin ids; a kid and a filename cannot disagree.

### 5.2 Publish-validation pipeline

Stages run in order. Stages 1–3 abort immediately; 4–8 accumulate findings and report them together in the `400` body. Nothing touches `plugins/` before stage 9, and stage 9 is a single atomic rename.

1. **Transport.** `POST /api/v1/plugins/publish` only; `Content-Type` must be `application/vnd.candyriya.plugin` or `application/octet-stream` (else `415`); `Content-Length` present and ≤ `PM_MAX_BUNDLE_BYTES` (default 64 MiB, else `413`); the body is streamed with a hard cap, aborted on excess.
2. **Rate limit** (`src/ratelimit.ts`): publish bucket, default 10 requests/min per IP, burst 3 (else `429`).
3. **Authentication** (`src/auth.ts`): `x-api-key` compared constant-time against `PM_API_KEY` (else `401`). Missing configured key = server refuses to start (see [§7](#7-security-posture)).
4. **Envelope**: magic, version == 1, header length ≤ 65536, total bytes == `Content-Length`, payload non-empty.
5. **Manifest**: JSON parse; every field type/range-checked per §5.1; `id` validated against the id grammar — this is also the **path check**: the id maps directly onto a directory name, so the grammar is the whitelist; `..`, slashes and leading dots are unrepresentable once the regex passes.
6. **Payload**: `size` == actual payload length; sha256 recomputed over the payload equals `manifest.sha256`.
7. **Signature** (`src/publisher-keys.ts`): `publisher` (kid) must match the kid grammar; `keys/publishers/<kid>.pub` must exist (else `403` — an unknown signer is not an honest publisher); the kid must not appear in `revocations.json` (else `403`); the ed25519 signature must verify over the payload bytes (else `400 bad_signature`).
8. **Compatibility**: `manifest.api` ∈ `PM_ACCEPTED_API` (else `422`).
9. **Commit** (`src/registry.ts`): the index is checked for `id@version` — if present, `409`. Otherwise the bundle is written to a random `tmp/` name, fsynced, renamed to `plugins/<id>/<version>/plugin.plugin` (parents created `0755`, file `0644`). The index is updated in memory, `index.json` is rewritten atomically, the outcome is appended to `audit.log` and fsynced — only then does the client see `201`.

Rejected uploads never create directories, never write files, and are logged (reason only, never key material) and audited. There is no "best effort" publish mode: if any step fails, the response is an error and the disk is untouched.

Revocation is deliberately cheap: adding a kid to `revocations.json` closes it to new publishes immediately, and `GET .../download` of any bundle signed by that kid returns `410 Gone`. Revoking a single bundle by sha256 works the same for takedown of one compromised version without touching the rest.

## 6. Listings, health and metrics

**Listing / detail** are served from the in-memory index — never a live disk read on the hot path. `GET /api/v1/plugins` returns a sorted summary array (`id`, `name`, latest `version`, `versions[]`, latest `sha256`). `GET /api/v1/plugins/:id` returns the full per-version record. Both are pure memory reads — serialization of a few KB, nothing touches disk. `ETag` is a monotonic index-version counter bumped on every publish; `Cache-Control: public, max-age=60` — the list changes only on publish.

**Download** streams `plugins/<id>/<version>/plugin.plugin` from disk on every request (no byte cache). `HEAD` is supported for the same path with no body. Headers: `Content-Type: application/vnd.candyriya.plugin`, `Content-Length`, `ETag: "<sha256>"`, `Cache-Control: public, max-age=31536000, immutable` (a version URL pins the exact bytes), `X-Checksum-Sha256: <sha256>` so clients can verify without parsing the manifest. Revoked versions return `410`. Cost per download is one open + stream — the page cache absorbs popular bundles.

**`/health`** returns `200` whenever the process is alive. No I/O, no locks; suitable for load-balancer liveness.

**`/ready`** returns `503` until the startup index scan completes, then `200`. Checks: scan finished, `plugins/` readable. It tells the truth about the only things that can make the server useless — a missing/unreadable data dir or a failed boot scan.

**`/metrics`** — Prometheus text exposition on the same port, unauthenticated; if exposure beyond the internal network is a concern, the path is blocked at the reverse proxy ([§9](#9-deployment)). Exposed metrics:

- `http_requests_total{method,route,status}` — counter
- `http_request_duration_seconds{route}` — histogram (`.005 … 2.5`)
- `pm_plugins_total` — gauge, versions in the index
- `pm_publishes_total{result="accepted|rejected"}` — counter
- `pm_publish_rejections_total{reason}` — counter (`bad_signature`, `unknown_publisher`, `revoked`, `duplicate_version`, …)
- `pm_downloads_total` — counter (no per-id labels — unbounded cardinality is forbidden)
- `pm_index_build_seconds` — gauge, last startup scan duration

Costs are negligible: in-memory counters plus a constant-size render on scrape. A representative scrape:

```text
# HELP pm_plugins_total Versions in the index.
# TYPE pm_plugins_total gauge
pm_plugins_total 12
http_requests_total{method="GET",route="/api/v1/plugins",status="200"} 1042
http_request_duration_seconds_bucket{route="/api/v1/plugins/:id/download",le="0.25"} 311
```

**Logs.** One structured JSON line per request on stdout (`ts`, `level`, `event=http_request`, `method`, `route`, `status`, `duration_ms`, `ip`), plus lifecycle lines (`startup`, `shutdown`, `index_built`, `publish_accepted`, `publish_rejected`). No request bodies, no key material, no full bundle bytes, no stack traces at error level for expected 4xx. Consumers of the log are the operator and the audit pipeline; keep the shape stable and diffable.

## 7. Security posture

**Trust boundary.**

- *Outside the boundary:* every network client, every byte of every request body, every bundle ever uploaded. All hostile until validated.
- *Inside:* the process, `$PM_DATA_DIR` (operator-controlled), and `PM_API_KEY` (operator-controlled secret in the environment).
- *The reverse proxy is part of the boundary, not a bypass:* TLS terminates there; the backend speaks plain HTTP on loopback. Only the proxy is reachable from outside; `/metrics` and `/ready` are not routable externally.

**Why read endpoints need no auth.** The registry's contents are public by definition — signed bundles and metadata meant for anyone to fetch. Auth on reads would add friction and zero confidentiality: the bytes are world-readable by design. What reads need is integrity (sha256/ed25519 verified end to end by the client) and availability limits (the read rate limiter) — not credentials.

**How publish authenticates writers.** A publish requires **two independent credentials; either one alone is insufficient**:

1. `PM_API_KEY` — a single-purpose, shared transport secret. It authorizes *using the endpoint*, nothing else: no read of private data, no delete, no revocation, no index access beyond what reads already provide. One key exists (operator-held); compared constant-time, never logged, never in URLs. Rotation = set a new value, restart.
2. An authorized publisher ed25519 key — the signature is verified against `keys/publishers/<kid>.pub` at publish time. Stealing `PM_API_KEY` without a publisher private key yields `400 bad_signature` on every attempt. Stealing a publisher private key alone yields `401`.

The model is deliberately not multi-user: phase 1 is a single-operator registry. No accounts, sessions, roles or cookies — one shared key plus per-publisher signing keys with an on-disk revocation list. That is the honest shape for the current threat model; anything bigger is phase 2+, not something to half-implement now.

**The open publish endpoint.** The bootstrap accepted unauthenticated publishes with a warning when `PM_API_KEY` was unset. That is unacceptable wherever the port is reachable. The fix: fail-fast at startup (no key, no server), constant-time compare, constant-shape error bodies (no oracle on which check failed), audit logging of every attempt.

**Rate limiting.** Per-IP token buckets, checked before routing: reads default 600/min (burst 50) — enough for a CLI, stingy enough to blunt scrapers; publish defaults 10/min (burst 3) — publication is rare by nature. On trip: `429` + `Retry-After`, rejection counted. `413` bounds bodies at 64 MiB. Bun's idle timeout covers slow-loris; the reverse proxy adds its own timeouts. The limiter keys on the forwarded client address supplied by the (trusted) reverse proxy, not the loopback peer — see [§12](#12-system-wide-risks) for the failure mode when that is misconfigured. Limits are in-memory and per instance — correct for the single-instance phase-1 model; a multi-instance deployment would need a shared limiter, which is out of scope.

**Path safety.** Ids are validated against `[a-z0-9_.-]{1,64}` before touching disk; storage only ever joins validated ids and versions onto `$PM_DATA_DIR/plugins`; `..`, absolute paths and separator injection are unrepresentable. The version directory is semver-strict the same way.

**Secrets.** `PM_API_KEY` comes from the environment — never from a committed file, never in logs, never in error responses. Publisher **private** keys do not exist on the server; only public keys. `audit.log` records kids and hashes, never key material.

**Audit.** Every publish attempt is appended to `audit.log` before the response is sent; writes are fsynced; failure to audit fails the publish. The log is the incident-response artifact: who published what, when, from which address, accepted or rejected and why.

## 8. The operator-facing index (phase 1 note)

Phase 1 has no operator UI and none is planned; the **CLI is the primary consumer**, speaking the JSON read API above. The one index artifact is `index.json` in `$PM_DATA_DIR`: a deterministic, sorted, machine-readable dump of the registry (`generatedAt`, accepted API levels, every plugin with versions, sha256s and sizes), rebuilt at startup and on each publish. It is unsigned in phase 1 and consumed by nothing yet — it exists so the derived state is inspectable and so a later phase can sign it (ed25519) and serve it for CDN/R2 distribution without re-blocking the disk layout. Do not build consumers for it in phase 1; the read API is the contract.

## 9. Deployment

Single binary, read disk, no database — no runtime dependencies beyond `bun`. Three ways to run it; all do the same thing.

**Environment**

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8093` | listen port |
| `PM_DATA_DIR` | `./data` (dev) | state directory (`/var/lib/packetmanager` in prod) |
| `PM_API_KEY` | — (required) | publish secret; server exits at startup if unset |
| `PM_BASE_URL` | `http://localhost:8093` | self URL recorded in `index.json` |
| `PM_ACCEPTED_API` | `0.1` | comma-separated accepted plugin API levels |
| `PM_MAX_BUNDLE_BYTES` | `67108864` | publish body cap (64 MiB) |
| `PM_RATE_READ_PER_MIN` | `600` | read limiter per IP |
| `PM_RATE_PUBLISH_PER_MIN` | `10` | publish limiter per IP |

**Directly under bun** (dev / small boxes):

```sh
PM_DATA_DIR=/var/lib/packetmanager PM_API_KEY=... bun run src/index.ts
```

**pm2** (prod on a VPS): `ecosystem.config.cjs` with `script: 'bun'`, `args: 'run src/index.ts'`, `env` carrying `PM_DATA_DIR` and `PM_API_KEY` (mode `0600`, out of the repo), `autorestart: true`, `max_memory_restart: '512M'`. `pm2-runtime` in containers. Minimal ecosystem file:

```js
// ecosystem.config.cjs — keep this file out of the repo
module.exports = {
  apps: [{ name: 'packetmanager', script: 'bun', args: 'run src/index.ts',
           cwd: '/opt/packetmanager', autorestart: true, max_memory_restart: '512M',
           env: { PORT: '8093', PM_DATA_DIR: '/var/lib/packetmanager', PM_API_KEY: 'change-me-out-of-repo' } }],
};
```

**Docker**: `FROM oven/bun:1`, copy `package.json` / `bun.lock` / `src` / `docs`, `bun install --frozen-lockfile`, `USER bun`, `VOLUME /data`, `ENV PM_DATA_DIR=/data PORT=8093`, `EXPOSE 8093`, `HEALTHCHECK` hitting `http://127.0.0.1:8093/health`. Pass `PM_API_KEY` via `docker run -e` or a `0600` `--env-file`; never bake it into the image.

**Reverse proxy.** nginx/caddy terminates TLS and proxies to `127.0.0.1:8093`. GETs on `location /api/v1/plugins` are `proxy_cache`-able (honoring `max-age=60`); `POST` is never cached; `/metrics` is allow-listed to internal ranges or `deny all`; `/ready` and `/health` pass through for the load balancer. Publish body timeout ≥ 60s. The proxy must also **overwrite** `X-Forwarded-For` (not pass a client-supplied one through), since the rate limiter keys on it — see [§12](#12-system-wide-risks). Minimal nginx shape:

```nginx
location /api/v1/plugins { proxy_pass http://127.0.0.1:8093; proxy_cache_valid 200 60s; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 64m; }
location /api/v1/plugins/publish { proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 64m; proxy_request_buffering on; }
location = /metrics { allow 10.0.0.0/8; deny all; proxy_pass http://127.0.0.1:8093; }
location = /health { proxy_pass http://127.0.0.1:8093; access_log off; }
```

**How the proxy connects.** Today it doesn't. Nothing in the Candyriya proxy fetches from the registry at startup, and phase 1 deliberately does not add that. The consumers are the CLI (install/update, resolving deps and verifying signatures) and humans with curl. A later phase will teach the proxy to fetch and verify a signed index at startup; that is blocked on the signed-`index.json` decision and is not designed here.

**Operations.** Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, let in-flight responses finish, exit `0`. Upgrades: stop, replace, start — the startup scan rebuilds the index; no migration step exists. Scaling: vertical only for phase 1; horizontal would require shared storage or R2/CDN and is out of scope. Backups: snapshot `$PM_DATA_DIR` (see [§4](#4-storage-pm_data_dir-layout)).

## 10. Modules that do not exist yet

Phase 1 needs (in [§3](#3-module-responsibilities)). Still absent and deliberately **not** part of phase 1:

- `src/verify.ts` — operator-triggered deep integrity sweep (re-hash every bundle against `manifest.sha256`, report drifted files). Needed because startup deliberately trusts manifests; without it, silent disk corruption is only caught by clients at download time.
- index.json signing — ed25519 signature over the derived index, served as `index.json.sig`; prerequisite for CDN/R2 distribution and for the proxy's future startup fetch.
- Revocation endpoint — today takedown is an operator editing `revocations.json`; a key-authenticated `POST /admin/revoke` belongs with real operator auth, which phase 1 does not have.
- Soft-delete / unpublish — phase 1 has no delete at all ([§12](#12-system-wide-risks)); unpublish semantics (yank latest, keep bytes, `410`) need a design of their own.
- Backup helper — a `pm backup` snapshot command; operators currently use rsync/restic directly.
- Multi-instance support — shared limiter, shared index or object storage; out of scope until the registry outgrows one box.
- Web UI, search, categories, ratings — phase 3+ territory, if ever.

## 11. Decisions recorded in this document

1. **Flat disk + scan-at-startup in-memory index; no SQLite.** `plugins/` is the only source of truth; `index.json` is derived (deterministic, unsigned) and regenerated at startup and on publish.
2. **Bundles stored verbatim** at `plugins/<id>/<version>/plugin.plugin`. No sidecar `manifest.json`; the manifest lives inside the bundle.
3. **In-memory index serves all reads.** No live disk reads for list/detail; downloads stream from disk; no byte cache (page cache suffices).
4. **Startup scan is header-only** plus a file-size vs `manifest.size` stat check; payload bytes are never read at boot. Deep integrity verification is a separate operator step (`src/verify.ts`, future).
5. **Fail-fast startup without `PM_API_KEY`**; constant-time compare; the bootstrap's open-by-default publish endpoint is removed.
6. **Publish requires two independent credentials** (transport API key + authorized publisher ed25519 key); the audit line is fsynced before `201` is returned — an unaudited publish never succeeds.
7. **`.plugin` v1 envelope**: `CNPL` magic, version 1, ≤ 64 KiB JSON manifest, then raw payload; sha256 + ed25519 over the payload bytes; binary body on the wire, not base64-in-JSON.
8. **Immutable versions**: re-publish of `id@version` → `409`. No `PUT`, no overwrite, no delete endpoint in phase 1.
9. **Revocation via `revocations.json`**, enforced at publish (kid check, `403`) and at download (`410`); applied immediately, no restart; per-bundle (by sha256) or per-key (by kid).
10. **`/metrics` on the same port, unauthenticated**, expected to be `deny`-listed at the reverse proxy; no per-plugin label cardinality.
11. **No CLI-upload / proxy-fetch integration in phase 1** — the proxy does not call the registry at startup; the CLI (separate component) consumes the read API directly.
12. **Single-instance model.** In-memory rate limiter and index are correct for one process; horizontal scaling is explicitly out of scope.
13. **No fallback paths.** Every decision above is the decision; there is no "if that fails, do something else" mode anywhere in this design.

## 12. System-wide risks

- **Single-operator mode.** One shared API key; one human-with-shell owns the host, the keys and the backups. Compromise of the host = compromise of the registry. Accepted for phase 1; not mitigated inside the server. What mitigates it: the two-credential publish model (a host attacker still needs publisher private keys, which are not on the server), backups, the audit log. Multi-operator auth is phase 2+.
- **Deletes are dangerous — and phase 1 has none, on purpose.** The only copy of a bundle lives in `$PM_DATA_DIR/plugins/`. There is no delete or unpublish endpoint, and operators must not `rm` bundles casually: a removed bundle is gone until restored from backup. Takedown is `revocations.json` (`410` on download, key closed to new publishes), not deletion. A future delete must be soft-delete with a backup taken first — never a direct unlink of the only copy.
- **Publishers need revoking — and revocation is the only "admin" the server has.** If a publisher key leaks, the operator adds the kid to `revocations.json`. Two honest limitations: (a) revocation is effective only for future fetches — copies already downloaded, and any CDN cache in front of this service, keep working until they expire (keep lifetimes moderate for anything but immutable version URLs, or purge the CDN); (b) the server has no channel back to installed proxies — a revoked plugin keeps running on already-installed instances until its operator removes it. Revocation stops distribution; it does not uninstall.
- **`PM_API_KEY` leaks easily in operation** (pm2 dumps, `.env` in shell history, `docker inspect`). Mitigation is process hygiene: `0600` files, never commit, prefer secret managers, rotate on suspicion. The server cannot detect a leaked key; the audit log can show its use.
- **The audit log shares fate with the host.** It is append-only by the server's own hand, but anyone with root on the box can edit or truncate it. If the log must be tamper-evident, ship every line off-box (rsyslog, vector, or a log service) at write time; phase 1 does not do this itself. Treat on-box `audit.log` as evidence with the same trust level as the rest of the filesystem.
- **Disk-full during publish** is the one runtime failure that can interrupt the commit step. The design keeps it safe — `tmp/` write fails, `plugins/` is untouched, the client gets `500` — but an operator watching `pm_publishes_total{result="rejected"}` with reason `internal` should check free space first.
- **Index drift by hand-editing.** Anyone who copies or edits `plugins/` while the server runs leaves the in-memory index stale (built at startup, updated only by the publish path). Ops rule: stop the server, change files, start it. The server trusts its own writes and its startup scan — nothing else.
- **One shared IP behind the proxy blunts the per-IP limiter.** When the reverse proxy is the only client, every request arrives from `127.0.0.1` (or a small pool): the per-IP read limiter protects nothing and the publish limiter throttles the proxy itself, not the abuser. Two honest options: run the limiter off the `X-Forwarded-For` set by the proxy with `trustProxy` semantics (the proxy is part of the trust boundary — it overwrites the header), or accept the global bucket and rely on proxy-level rate limiting and the API key. This document chooses the former: the limiter reads the forwarded client address, and the reverse proxy is required to strip inbound `X-Forwarded-For` and set its own — otherwise the header is attacker-controlled and the limiter is a joke. Do not deploy behind a proxy that passes client headers through.
- **Unsigned `index.json`** in phase 1 means a client consuming the file directly cannot tell it from a forgery. Nobody consumes it yet; the moment something does, signing must land first (see [§10](#10-modules-that-do-not-exist-yet)).
- **Moderation is process, not code.** Any holder of an authorized key can publish; there is no pre-publication review in the software. Namespace anti-squat and review-before-publish are operator policy — the server enforces signatures and revocation, nothing more. Pretending otherwise would be lying about the trust model.

Related reading: [README](../README.md) (project overview and licensing), and the phase-1 epic in the issue tracker (binding scope for this milestone).
