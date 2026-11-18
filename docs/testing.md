# Testing strategy

How the packetmanager service is tested, from unit up to a signed-bundle pipeline, and what the CI gate enforces. This document is the contract for every test that lands in this repo.

## TOC

1. [Purpose and scope](#1-purpose-and-scope)
2. [Framework and runner policy](#2-framework-and-runner-policy)
3. [Test layout and file naming](#3-test-layout-and-file-naming)
4. [Fixture store and on-disk state](#4-fixture-store-and-on-disk-state)
5. [Unit tests — src/registry.ts](#5-unit-tests--srcregistryts)
6. [Unit tests — src/auth.ts](#6-unit-tests--srcauthts)
7. [Unit tests — signature verification](#7-unit-tests--signature-verification)
8. [Integration tests — in-process HTTP](#8-integration-tests--in-process-http)
9. [Smoke tests](#9-smoke-tests)
10. [Beyond smoke — signed bundle end-to-end](#10-beyond-smoke--signed-bundle-end-to-end)
11. [Negative cases — statuses and body shapes](#11-negative-cases--statuses-and-body-shapes)
12. [Network and environment isolation](#12-network-and-environment-isolation)
13. [CI gate](#13-ci-gate)
14. [What the gate does not test yet](#14-what-the-gate-does-not-test-yet)
15. [Current gaps and required code changes](#15-current-gaps-and-required-code-changes)

## 1. Purpose and scope

Scope: automated testing of the HTTP plugin registry service — publish, list, detail, download, signature verification, the on-disk store. A strategy, not a run report. Out of scope: benchmarking, fuzzing, anything needing the production signing key or the live network (§12–14).

Rules that apply everywhere:

- No test may bind port 8093. No test may make an outbound network call.
- No test may read or write the operator's real `PM_DATA_DIR`.
- Every test that touches the filesystem uses a fresh tempdir and removes it.
- A red test is never silenced with `skip`. See §2.

## 2. Framework and runner policy

**Framework: Bun's native test runner** (`bun:test`). No jest, vitest or tape. It is already a dependency, it is fast, and it runs the same TypeScript the server runs.

```sh
bun test                 # the whole suite
bun test tests/unit      # one layer
bun test --coverage      # informational, not gated yet
```

`package.json` maps `bun run test` to `bun test`; CI calls `bun test` directly (§13).

**What "skip" means here — exactly one thing.** `test.skip` / `describe.skip` are reserved for tests that require the live network or credentials CI does not have. Such tests execute only when `PM_TEST_NETWORK=1` is set, carry a reason (`test.skip('needs live index mirror', ...)`), and are never added to silence a failing assertion. The default `bun test` never touches the network, and must pass on a machine with the cable unplugged. A skip used to hide a red test, a skip without the env gate, or a committed `test.only` are review rejects. Without the gate: never skipped, never run, never networked.

## 3. Test layout and file naming

```
tests/
  fixtures/unsigned-offline-canary-1.0.0/   # committed, static
    plugin.toml
    unsigned-offline-canary-1.0.0.plugin
  helpers/
    temp-store.ts   # mkdtemp / rm helpers, staging
    keys.ts         # ephemeral ed25519 keypair + signing
  unit/        registry.test.ts  auth.test.ts  signature.test.ts
  integration/ api.test.ts
  smoke/       smoke.test.ts
  e2e/         bundle.test.ts
```

One layer per directory. Fixtures are committed static bytes; anything derived (keypairs, signatures, staged stores) is generated per run in a tempdir, never committed.

## 4. Fixture store and on-disk state

### 4.1 Temp store per test

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

PM_DATA_DIR = await mkdtemp(join(tmpdir(), 'pm-test-'));
// afterEach:
await rm(PM_DATA_DIR, { recursive: true, force: true });
```

The harness sets `process.env.PM_DATA_DIR = PM_DATA_DIR` in `beforeEach`, removes it in `afterEach`, and drops any inherited `PM_DATA_DIR` at suite start. `PluginRegistry.freshTempDir()` hardcodes POSIX `/tmp`; it is unusable on Windows and must be replaced by this helper before the suite lands.

### 4.2 On-disk layout under test

```
$PM_DATA_DIR/
  index.json                # deterministic, versioned index
  keys/<key-id>.pub         # trusted publisher ed25519 public keys (PEM)
  plugins/
    unsigned-offline-canary/
      1.0.0/
        plugin.toml
        unsigned-offline-canary-1.0.0.plugin
        unsigned-offline-canary-1.0.0.plugin.sig
```

ID conventions: `^[a-z0-9_.-]{1,64}$`, lowercase. Version is strict semver: `\d+\.\d+\.\d+(-[0-9a-z.-]+)?`. The `.plugin` file is the wasm module; `.sig` is the raw 64-byte ed25519 signature over the exact `.plugin` bytes.

The bootstrap reads a flat `$PM_DATA_DIR/<id>/manifest.json` + `plugin.wasm` layout — phase-0 shape. The suite pins the target layout above; the migration lands in one PR that moves the reader, and fixture staging is the only place that knows the path.

### 4.3 The committed fixture

`tests/fixtures/unsigned-offline-canary-1.0.0/plugin.toml`:

```toml
id = "unsigned-offline-canary"
version = "1.0.0"
name = "Unsigned Offline Canary"
description = "Minimal fixture plugin exercised by the test suite"
authors = ["CandyriyaMC"]
license = "GPL-3.0-only"
plugin_main = "candyriya_plugin_main"
api = "0.1"
```

Required fields: `id`, `version`, `name`, `plugin_main`, `api`. `description`, `authors`, `website`, `license`, `depend`, `softdepend` are optional.

`unsigned-offline-canary-1.0.0.plugin` is the 8-byte header of a valid, empty wasm module — `00 61 73 6d 01 00 00 00` (`\0asm` + wasm version 1). Genuinely valid wasm, never loaded by these tests. Second fixture `invalid.plugin` holds ASCII bytes (`not-a-wasm-module`) for rejection tests. Staging: copy the fixture dir into `$PM_DATA_DIR/plugins/unsigned-offline-canary/1.0.0/` in the harness, generate keypair and `.sig` at that moment (§7), then run. Fixtures are never mutated in place; a broken-fixture test stages its own copy and edits it.

### 4.4 Cleanup contract

`beforeEach` fresh tempdir; `afterEach` `rm -rf`; e2e `afterAll` asserts no `pm-test-*` dirs remain in `tmpdir()`. Fixtures are read-only inputs; `.sig` files exist only inside temp stores.

## 5. Unit tests — src/registry.ts

File: `tests/unit/registry.test.ts`. Direct calls, no HTTP, tempdir store.

Validation (publish path):

- `publish returns ok with empty findings for a valid input`
- `publish rejects ids outside [a-z0-9_.-]{1,64} (uppercase, space, slash, dotdot, unicode)`
- `publish rejects an id longer than 64 characters`
- `publish rejects a name outside [a-z0-9][a-z0-9.-]{0,127}`
- `publish rejects non-semver versions (1.2, v1.2.3, 1.2.3.4)`
- `publish accepts semver prerelease versions (1.2.3-rc.1)`
- `publish rejects an empty module string`
- `publish rejects a module string that does not decode as base64`
- `publish rejects a missing signature when publish-time signing is enforced`
- `publish rejects a signature that fails ed25519 verification`
- `publish returns findings listing ALL missing required fields at once`

Listing and read paths:

- `listPublished returns an empty array when the data dir does not exist yet`
- `listPublished creates the data dir if missing`
- `listPublished returns summaries sorted by id ascending`
- `listPublished ignores non-directory entries at the store root`
- `listPublished skips a plugin directory whose manifest is missing or unreadable`
- `listPublished skips a plugin whose manifest parses but fails validation`
- `listPublished skips a bundle whose signature does not verify`
- `listPublished never lists an unsigned bundle`
- `getDetail returns null for an unknown id`
- `getDetail returns the parsed manifest for a known id`
- `getCore returns only id, name and version for a known id`
- `getCore returns null for an unknown id`

Bundle IO and helpers:

- `bundle read returns null for an unknown id`
- `bundle bytes written by publish round-trip byte-identically`
- `bundle path resolution never escapes the data dir (containment check)`
- `the temp-store helper returns unique paths per call`

## 6. Unit tests — src/auth.ts

File: `tests/unit/auth.test.ts`. Guard tested as middleware plus the comparison seam, independent of HTTP.

- `with PM_API_KEY unset the guard passes all paths and logs a warning`
- `publish path without x-api-key returns 401 and body {ok:false, reason:'unauthorized'}`
- `publish path with a wrong key returns 401`
- `publish path with the correct key passes through`
- `non-publish paths pass through without any key`
- `an empty x-api-key header is treated as missing`
- `header lookup is case-insensitive (X-API-Key, x-api-key, x-Api-Key)`
- `comparison returns false on length mismatch instead of throwing`
- `comparison requires exact byte equality, not case-folding or trimming`
- `comparison does not leak length or prefix (constant-time evaluation via crypto.timingSafeEqual, asserted at the seam)`
- `PM_API_KEY present but blank is treated as unset with a warning, not as an empty valid key`

**Auth timing.** The bootstrap compares keys with `provided === apiKey`, short-circuiting on the first differing byte and leaking timing and length. Contract for the rewritten guard: comparison goes through `crypto.timingSafeEqual` on equal-length digests (e.g. SHA-256 of supplied vs expected key). Unit tests assert the seam — different lengths never reach the comparator, equal lengths hit it, mismatch returns false — never wall-clock timing, which is flaky on shared CI runners and proves nothing.

## 7. Unit tests — signature verification

File: `tests/unit/signature.test.ts`. Module under test: `src/sig.ts` (new, small): `generateTestKeypair()`, `sign(payload, privateKey)`, `verify(payload, signature, publicKey): boolean`.

Library: **`node:crypto`, built in** — `generateKeyPairSync('ed25519')`, `sign(null, payload, privateKey)`, `verify(null, payload, publicKey)` (null algorithm = pure ed25519, no prehash). No new dependency. If a browser/worker target ever needs it, swap the implementation behind `src/sig.ts`; the tests stay.

- `generateTestKeypair produces a pair whose public half verifies the private half's signatures`
- `signing the fixture .plugin produces a 64-byte signature`
- `verify accepts a signature over the exact bytes`
- `verify rejects a signature after a one-byte flip in the payload`
- `verify rejects a signature produced by a different key`
- `verify rejects a truncated signature without throwing`
- `verify returns false, never throws, on malformed input`
- `the public key round-trips through PEM export/import without losing verifiability`

Harness usage (`tests/helpers/keys.ts`): per-test, generate an ephemeral pair, hold the private key in memory, write only the public key (PEM) into `$PM_DATA_DIR/keys/test-canary-<n>.pub`, sign the staged `.plugin` bytes, write the `.sig`. No private key material is ever written to disk in a fixture or committed.

## 8. Integration tests — in-process HTTP

File: `tests/integration/api.test.ts`. Server created in-process via `createServer({ apiKey, dataDir, baseUrl })` and driven with `app.handle(new Request('http://localhost/<path>'))`. Zero sockets, zero ports. Tempdir store per test (§4). Status codes asserted exactly; bodies asserted field-by-field, never by snapshot.

- `GET /health returns 200 {status:'ok'}`
- `GET /ready returns 200 {status:'ready'}`
- `GET /api/v1/plugins returns 200 [] on an empty store`
- `GET /api/v1/plugins returns summaries sorted by id ascending`
- `GET /api/v1/plugins/:id returns 200 with id, name, version, publishedAt and module`
- `GET /api/v1/plugins/:id returns 404 {ok:false, reason:'not found'} for an unknown id`
- `GET /api/v1/plugins/:id returns 400 {ok:false, reason:'invalid id'} for a malformed id`
- `GET /api/v1/plugins/:id/core returns only id, name, version`
- `GET /api/v1/plugins/:id/core returns 404 {ok:false, reason:'not found'} for an unknown id`
- `GET /api/v1/plugins/:id/download returns 200 with content-type application/wasm`
- `GET /api/v1/plugins/:id/download returns byte-identical content to what was published`
- `GET /api/v1/plugins/:id/download returns 404 {ok:false, reason:'not found'} for an unknown id`
- `GET /api/v1/plugins/:id/download returns 409 {ok:false, reason:'unsigned-bundle'} for an unsigned bundle`
- `POST /api/v1/plugins/publish without x-api-key returns 401`
- `POST /api/v1/plugins/publish with a wrong key returns 401`
- `POST /api/v1/plugins/publish with the correct key returns 200 {ok:true, plugin:{id, version}}`
- `POST /api/v1/plugins/publish with a schema-invalid body returns 400 with findings[]`
- `POST /api/v1/plugins/publish round-trips through list and download`
- `unknown routes return 404`
- `every error body in this suite carries {ok:false} plus a reason or findings`

When `GET /metrics` lands, its tests land in the same PR: 200, `text/plain` content-type, publish/download counters present. There is no route-without-a-test exception in this repo.

## 9. Smoke tests

File: `tests/smoke/smoke.test.ts`. The smallest proof that the process boots and answers. Under 2 seconds, no fixtures beyond an empty tempdir.

- `the server starts on an ephemeral port, answers /health with 200 {status:'ok'}, then shuts down cleanly`
- `the server answers /ready with 200 {status:'ready'} within a bounded time after listen`

Uses `app.listen(0)` (port 0 → OS-assigned) plus a real `fetch` to `/health`, then `app.stop()`. Proves the HTTP stack wiring, not the handlers. Everything else uses `app.handle`. A failure catchable only here is an escaped integration bug — the fix includes an integration test.

## 10. Beyond smoke — signed bundle end-to-end

File: `tests/e2e/bundle.test.ts`. Full pipeline: signed artifact on disk → discovered → listed → detailed → downloaded → verified, byte-identical. No network, no production keys.

- `a signed fixture staged in the store is discovered by the scanner`
- `the staged bundle is listed by GET /api/v1/plugins`
- `GET /api/v1/plugins/:id returns the staged bundle's detail with 200`
- `GET /api/v1/plugins/:id/download returns 200 with the exact fixture bytes (sha256 asserted)`
- `the downloaded bytes verify against the fixture .sig and the test public key`
- `the published-then-downloaded path produces byte-identical output to the staged fixture`
- `an unsigned bundle on disk is never listed and never downloadable`
- `a tampered bundle on disk (one flipped byte) is rejected at download and absent from list`
- `a bundle signed with an untrusted key is rejected at publish and absent from list`
- `removing the .sig after staging makes the bundle vanish from list and block download`

Assertion coverage targets the three links that break separately: discovery, transfer (bytes intact), trust (signature verifies). Any link failing fails the test.

## 11. Negative cases — statuses and body shapes

The most important section. Two error shapes, both with `ok:false`:

1. **Validation failure** (publish input): `{"ok":false,"findings":["...", ...]}`
2. **Single-reason failure** (auth, lookup, integrity): `{"ok":false,"reason":"<slug>"}`

| # | Scenario | Enforcement point | Status | Body |
|---|----------|-------------------|--------|------|
| a | `.plugin` present, `.sig` absent | publish / scan / download | 400 / skip / 409 | findings `["signature required: publish the .plugin together with its .sig"]`; download `{"ok":false,"reason":"unsigned-bundle"}` |
| b | signature does not match payload | publish / scan / download | 400 / skip / 409 | findings `["signature verification failed"]`; download `{"ok":false,"reason":"signature-mismatch"}` |
| c | manifest missing required fields | publish / scan | 400 / skip | findings listing all missing fields, e.g. `["missing required field: version","missing required field: plugin_main"]` |
| d | id fails `[a-z0-9_.-]{1,64}` | publish and all `:id` routes | 400 | publish: `{"ok":false,"findings":["invalid id"]}`; `:id` routes: `{"ok":false,"reason":"invalid id"}` |
| e | download path escapes `$PM_DATA_DIR` | id check + path containment | 400 | `{"ok":false,"reason":"invalid id"}` — outside bytes never served |
| f | publish hit with no API key | auth guard | 401 (or open dev mode) | `{"ok":false,"reason":"unauthorized"}` |

Detail per case:

**(a) Missing `.sig`.** Publish: 400 with findings, never a 5xx, never a silent accept. On disk: not listed, download returns 409 `{"ok":false,"reason":"unsigned-bundle"}`; scan logs one warning naming the bundle.

**(b) Signature mismatch.** Publish: 400 `findings:["signature verification failed"]`. On disk: scan treats the bundle as untrusted — skipped from list, one warning. Download of a bundle whose current bytes no longer match its `.sig` returns 409 `{"ok":false,"reason":"signature-mismatch"}`. Detection at read time, not only at publish, because `$PM_DATA_DIR` is writable by whoever runs the service.

**(c) Manifest missing required fields.** Required: `id`, `version`, `name`, `plugin_main`, `api`. Publish collects **all** missing fields into one `findings` array (never one at a time). On disk, an unreadable or invalid `plugin.toml` causes the bundle to be skipped with a warning — never listed, never downloadable.

**(d) Id outside the pattern.** `^[a-z0-9_.-]{1,64}$`. Publish: 400 `{"ok":false,"findings":["invalid id"]}`. Any `:id` route with an id outside the class: 400 `{"ok":false,"reason":"invalid id"}` before the path resolver runs. Primary traversal defense, not a nicety.

**(e) Path escape.** Three layers, each tested: (1) id pattern rejects `/`, `\`, `..`, `%2e`-decoded dots; (2) path builder resolves `resolve(dataDir, id, version, filename)` and asserts the result starts with `resolve(dataDir) + sep` — unit-tested with adversarial ids, asserted in the handler; (3) symlinks inside the store pointing outside the root are refused at read (`realpath` containment). Any layer tripping yields 400 or 404 per the table — never outside bytes. Test name: `download never serves bytes outside the data dir`.

**(f) Publish with no API key.** With `PM_API_KEY` set: no header → 401 `{"ok":false,"reason":"unauthorized"}`; wrong key → same 401; correct key → proceeds. With `PM_API_KEY` unset the server runs open dev mode: publish succeeds **and** a warning is logged; the test asserts the warning fires. In production (`NODE_ENV=production`) the server refuses to boot without `PM_API_KEY` — `createServer` throws before listening. CI never sets `PM_API_KEY` globally; every test that exercises publish sets its own key.

Status-code summary: 400 validation · 401 authentication · 404 lookup miss · 409 integrity/trust failure · 200 success. No endpoint returns 5xx for any input a client can construct; a 5xx in this suite is a finding, not an expected branch.

## 12. Network and environment isolation

- **Per-test tempdirs.** `PM_DATA_DIR` is set in `beforeEach` to `mkdtemp(join(os.tmpdir(), 'pm-test-'))`, removed in `afterEach`. Tests never inherit the developer's `PM_DATA_DIR`; the harness scrubs it at start.
- **Ports.** 8093 is never bound. Unit/integration use `app.handle()` with zero sockets; smoke binds port 0. No fixture hardcodes a host.
- **No outbound calls.** Phase 1 performs no egress. Suites replace `globalThis.fetch` with a stub that throws `test attempted a network call: <url>` in `beforeEach` and restore it in `afterEach`. A hit is a failure, not a warning.
- **Env hygiene.** `PM_API_KEY` set explicitly per suite. `PM_BASE_URL` unset. `NODE_ENV` per test when the production profile is exercised. Nothing reads `.env`; no dotenv dependency.
- **Skip gate.** A genuinely networked test goes behind `PM_TEST_NETWORK=1` and uses `test.skip` with a reason otherwise (§2). No other skip exists.
- **Acceptance criterion.** `bun test` passes with no network route. CI's network being up is irrelevant to correctness.

## 13. CI gate

Workflow `.github/workflows/test.yml`. One job; the gate stays fast.

```yaml
name: test
on:
  push:
    branches: [dev, main]
  pull_request:
jobs:
  bun-test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.2
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Run tests
        run: bun test
```

- `bun install --frozen-lockfile` fails on a stale `bun.lock`; lockfile is committed.
- `bun test` — one command, identical locally and in CI.
- No secrets referenced. Tests generate their own keys and tempdirs; the workflow needs no `PM_API_KEY`.
- Required before merge; direct pushes to `main` are not allowed.

## 14. What the gate does not test yet

- **The real publisher pipeline.** Production signing uses the offline release ed25519 key; it never enters CI. The gate exercises the full sign → verify → serve path with ephemeral keys only. Smoke and e2e are therefore unit-grade for trust: they prove the mechanics, not production key custody, the release ceremony, or index attestation. If the publisher pipeline needs a signer key, smoke stays unit-only.
- **`/metrics`.** Not implemented; ships together with its tests.
- **Consumer side.** Resolve-and-install into a running `candyriya` proxy (download → verify → load) belongs to the proxy's integration suite.
- **Scale and storage internals.** Deterministic `index.json` at thousands of bundles, filesystem vs SQLite, R2/CDN, parallel-publish concurrency. The integration suite is backend-agnostic — it tests `createServer`, not the layout — so a store swap must not change a single assertion.
- **Release artifacts.** Docker image build and tarball publishing.

Each lands with its own tests in the PR that adds it; the gate grows with the code, not after it.

## 15. Current gaps and required code changes

The bootstrap is phase-0. Landing this suite requires, in the same PR:

1. `PluginRegistry.freshTempDir()` hardcodes POSIX `/tmp` — replace with `fs/promises.mkdtemp` (§4).
2. `authGuard` compares with `===` — constant-time comparison (§6).
3. Publish has no signature field or verification — add `signature` (base64) to the publish body; sign payload = raw `.plugin` bytes; verify before write (§5, §7, §11).
4. `:id` routes do not validate the id class; `getDetail` returns `200 null` for unknown ids — return 400 / 404 `{ok:false, reason:...}` (§8, §11).
5. Id regex in `publish` lacks the `.` class member — align to `^[a-z0-9_.-]{1,64}$` everywhere (§11d).
6. Store layout is flat `<id>/manifest.json` — migrate to per-id per-version with `plugin.toml` (§4); fixture staging changes in one place.
7. `readManifest` naming is wasm-specific — rename to bundle IO aligned with the `.plugin` extension.

These are enumerated so the implementation PR can be reviewed against this list; nothing here is satisfied by stubs.
