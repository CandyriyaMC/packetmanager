# Publishing a plugin (authors)

This page is for people writing and publishing Candyriya plugins. It covers
what a `.plugin` bundle is, what `plugin.toml` must contain, how signing and
publishing work, and the rules that keep the public index trustworthy.

## What a `.plugin` is

A `.plugin` is a **signed bundle**: the WASM module your plugin compiles to,
a `plugin.toml` manifest, and nothing else executable. It is

- **versioned semantically** — `MAJOR.MINOR.PATCH`, immutable once published;
- **content-checked by ed25519 detached signature** — verified by the
  registry at publish time, before the version enters the public index;
- **addressed by `(id, version)`** — the index maps those to bundle bytes;
- **loaded against a plugin API level** — the proxy refuses a bundle whose
  `api` it does not support, which is what the `api` field in `plugin.toml`
  is for.

There is no scripting layer and no install-time code generation — what you
sign is what operators run.

## `plugin.toml` — what goes in it

The registry validates `id`, `name` and `version` at publish time, so those
must match the rules exactly:

| Field    | Rule                                        | Example       |
| -------- | ------------------------------------------- | ------------- |
| `id`     | `^[a-z0-9_-]{1,64}$`                        | `my-plugin`   |
| `name`   | `^[a-z0-9][a-z0-9.-]{0,127}$` (case-insens.)| `my-plugin`   |
| `version`| semver, optional pre-release                | `1.0.0`, `1.1.0-rc.1` |

Note the registry's `id` rule is stricter than the proxy's (which allows
dots) — stick to `[a-z0-9_-]{1,64}` and you are safe everywhere.

A complete minimum `plugin.toml`:

```toml
# validated by the registry at publish time
id = "my-plugin"          # ^[a-z0-9_-]{1,64}$
name = "my-plugin"        # ^[a-z0-9][a-z0-9.-]{0,127}$
version = "1.0.0"         # semver; pre-release suffix allowed

# required by the proxy loader (not checked by the registry)
plugin_main = "my_plugin" # export instantiated after load; absent = plugin fails to load
api = "0.1"               # plugin API level this bundle targets

# optional, for humans and for dependency resolution
description = "one line that shows up in the public index"
authors = ["You <you@example.org>"]
website = "https://plugins.example.org/my-plugin"
license = "MIT"
depend = ["other-plugin"]      # hard dependencies — must exist and load first
softdepend = ["nice-extra"]    # soft dependencies — load order only, never fatal

# inter-plugin API surface — omit or leave empty if other plugins never call you
[api]
exports = ["spawn_worker"]
```

Notes:

- `depend` is a **hard** requirement. If a hard dependency is missing from
  the index, fails signature verification, or fails to load, your plugin does
  not load either. The resolution error lists the actual chain.
- `softdepend` is an ordering hint — the loader tries those first, but their
  absence is never an error. Do not depend on soft order for correctness.
- `[api].exports` declares the functions other plugins may call through
  `call_api(plugin_id, fn_name, args)`. Empty (or missing section) means your
  plugin exports nothing — the default and the right default for most.
- `license` is expected for anything on a public registry.

## Signing your bundle

The registry verifies **detached** ed25519 signatures. "Detached" means the
signature is a separate artifact over the exact bytes of the bundle — nothing
is embedded, no canonicalization, no re-encoding. If the bytes change by one
bit, the signature does not match and the publish is rejected.

Conceptually, the flow is:

1. Generate an ed25519 keypair. Your private key never leaves your machine —
   `0600`, offline if you are that kind of careful.
2. Build the bundle from your compiled module and manifest.
3. Sign the exact bundle bytes with your private key, producing a
   detached signature.
4. Hand the operator your public key out of band (first publish) and publish
   the bundle + detached signature together (every publish).
5. The registry verifies the signature against the known publisher key list
   before the version enters the index. The index itself is signed with the
   registry's release key, so operators can verify what they download.

There is no signing tool shipped in this phase. A dedicated signing-tool
issue (`feat(sign): packetmanager ed25519 signing tool`) will follow the
phase 1 epic (issue #1) — watch the repo for it. Until it lands, any
standard ed25519 detached-signature tooling works (OpenSSL, libsodium), as
long as what you sign is byte-identical to what you publish. Do not "make do"
with RSA or ECDSA — the registry verifies ed25519, nothing else.

Two keys, two jobs:

- **your publisher key** — pins your identity per plugin; rotated on request
  if lost or compromised (see below).
- **the registry release key** — signs the index itself; not something you
  ever touch.

If your private key is lost or compromised, tell the operator immediately.
They rotate the pinned key in the publisher key list; your future publishes
verify against the new key. Versions already published stay valid — they were
verified at publish time — unless the operator yanks them (see below).

What the operator sees: the verification result at publish time, the
signature and key status in the publisher key list, and nothing else — no
dashboards, no audit UI.

## Publishing via the API

Publishing is a single authenticated HTTP call to the operator's registry
instance:

```console
curl -X POST https://pm.example.org/api/v1/plugins/publish \
  -H "x-api-key: $PM_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "id": "my-plugin",
    "name": "my-plugin",
    "version": "1.0.0",
    "module": "<base64-encoded bundle bytes>"
  }'
```

The `x-api-key` comes from the operator — ask for it, do not guess it, and
never commit it anywhere. Response bodies and what to do with them:

**200 OK** — stored.

```json
{ "ok": true, "plugin": { "id": "my-plugin", "version": "1.0.0" } }
```

**400 Bad Request** — validation failed; nothing was stored.

```json
{ "ok": false, "findings": ["invalid id", "invalid semver"] }
```

`findings` tells you exactly which check tripped — id/name charset, semver,
or a missing/empty `module`. Fix your manifest or payload and resubmit.

**401 Unauthorized** — wrong or missing key, or the instance is not accepting
publishes at all.

```json
{ "ok": false, "reason": "unauthorized" }
```

Most common cause by a wide margin: wrong or missing key. If the operator's
instance runs without `PM_API_KEY`, publish is hard-unauthorized for everyone
— that is the fail-closed posture, not a bug.

**5xx** — registry-side failure. Do not blind-retry in a loop: publishes are
not idempotent, and re-publishing can overwrite. Check
`GET /api/v1/plugins/my-plugin` first to see whether your version actually
landed.

Stability note: the endpoint path, the `x-api-key` header, and the
`ok` / `reason` / `findings` envelope are the stable contract. The bundle
inline-bytes body shown above is the current wire format — the phase 1 epic
is finalizing the `.plugin` upload shape, so expect exactly that one field
to change, and nothing else.

## Shipping a new version

1. Land your changes, tag them, make sure the plugin actually works on a
   proxy.
2. Bump `version` in `plugin.toml` (semver — see discipline below).
3. Rebuild the bundle.
4. Re-sign the new bytes with your key. New bytes, new signature.
5. Get the version reviewed if it needs it (first publish, or any `api`
   bump — see below). Routine patch/minor bumps ride the normal flow without
   ceremony.
6. Publish with the API call above.
7. Verify what is actually live:

   ```console
   curl -fsS https://pm.example.org/api/v1/plugins/my-plugin
   ```

   The index is rebuilt deterministically from the bundles on disk, so once
   your publish stores, the bumped version shows up on the public index
   without anyone hand-editing anything. If it does not show up, that is an
   operator issue — ping them with the id and version.

## Versioning discipline

- **semver, strictly.** Breaking change → major. New functionality, no
  breakage → minor. Fix → patch. Pre-release suffixes (`1.1.0-rc.1`) for
  things you want operators to try before they trust.
- **Releases are immutable.** Never re-publish `1.0.0` with different bytes —
  cut `1.0.1`. (The current bootstrap overwrites an existing version in
  place; that is placeholder behavior, not the contract — do not rely on it.)
- **`api` bumps always mean re-review.** A new plugin API level changes what
  the proxy will load and how it calls you. The registry treats that as a
  re-review by definition — your new-`api` version does not enter the public
  index without it, even if the `plugin.toml` diff is one line.
- **Dependency graph rules.** Resolution is topological (Kahn's algorithm):
  hard `depend` first, `softdepend` order within that. Cycle anywhere in the
  graph → resolution error naming the cycle, and nothing in the cycle loads.
  Duplicate id in the graph → resolution error. Libraries load before
  plugins. Unresolvable hard dep → your plugin fails; the operator sees the
  error, not a half-working plugin.
- **Churn vs breaking.** Plenty of small patches are fine. Churn is not a
  release strategy, though — do not republish identical bytes under new
  version numbers, ever. Changed or removed exports, changed semantics, a
  new `api` level, dropped guarantees — those are breaking, and they cost you
  a re-review.
- **Yanks and removals are manual, operator-only.** There is no self-service
  unpublish. If a release must come down (leaked private key, critical
  vulnerability, corrupted bytes), contact the operator with `id`, `version`
  and the reason — they delete the bundle and rebuild the index using the
  operator's `PM_API_KEY`. Removal is not retroactive: copies already
  installed on proxies are not recalled.

## Lifecycle labels

These are the shared labels the registry, the operator, and you use — the
same words everywhere:

- **DISCOVERED** — found (present on disk / visible in the index); nothing
  loaded yet.
- **LOADED** — bundle read, signature verified, manifest parsed, dependencies
  resolved.
- **ENABLED** — live; the plugin's exports are callable.
- **DISABLED** — deliberately off. Operator action, policy, or a failed
  enable. The bundle stays on disk; it is simply not loaded.

You publish bundles; operators decide ENABLED vs DISABLED. If your plugin is
stuck at DISCOVERED or LOADED-but-not-ENABLED, that is an operator-side
state, not a registry bug — re-publishing the same bytes will not fix it.

## Endpoint quick reference

| Endpoint                          | Purpose                  | Auth        |
| --------------------------------- | ------------------------ | ----------- |
| `GET /api/v1/plugins`             | List published plugins   | none        |
| `GET /api/v1/plugins/:id`         | Plugin detail            | none        |
| `GET /api/v1/plugins/:id/download`| Bundle bytes             | none        |
| `GET /health` / `GET /ready`      | Service probes           | none        |
| `POST /api/v1/plugins/publish`    | Publish a new version    | `x-api-key` |
