# Candyriya `.plugin` bundle specification

Contract for plugins distributed through the Candyriya PacketManager (`packetmanager`) and installed into the Candyriya proxy. Covers the bundle format, embedded manifest, on-disk index, signature and trust model, version compatibility, lifecycle states. HTTP endpoints and publish UX are separate contracts. Normative unless marked otherwise. In scope: bundle container, manifest schema, index layout, key management and revocation, compatibility rules, install flow, lifecycle labels. Out of scope: HTTP endpoints, publish-path auth, web UI, governance, the proxy's plugin runtime. Rust APIs appear only where they constrain the bundle format. One manifest, one source of truth: the manifest inside a `.plugin` is byte-identical to the `plugin.toml` the proxy loader reads after install; no translation layer exists or may be introduced.

## Contents

1. The `.plugin` file - bundle format
2. Manifest (`plugin.toml`) - fields and validation
3. Index layout on disk
4. Signature scheme
5. Trust model and revocation
6. Version compatibility and install refusal
7. Lifecycle states
8. Install paths: laptop to working install
9. Worked example: `authenticate-with-totp-1.2.3.plugin`
10. Plugin messaging channels and future `call_api`
11. Security assumptions

## 1. The `.plugin` file - bundle format

A `.plugin` file **is an uncompressed POSIX ustar archive** with a fixed member set, member order, and member metadata. Not a single signed wasm, not gzip, not a renamed directory.

Members, in mandatory order:

| # | Member | Required | Notes |
|---|--------|----------|-------|
| 1 | `plugin.toml` | yes | Manifest (§2). Signature covers exactly these bytes. |
| 2 | `plugin.wasm` | yes | Extism module. Digest pinned in the manifest. |
| 3 | `plugin.sig` | yes | ed25519 detached signature over the `plugin.toml` bytes (§4). |
| 4 | `README.md` | no | <= 256 KiB, UTF-8. |
| 5 | `icon.png` | no | <= 256 KiB; `manifest.icon` must be `"icon.png"`. |

No other member may appear; names are exact (`./plugin.toml` is invalid). `plugin.toml` <= 64 KiB; `plugin.wasm` <= 64 MiB; archive total <= 128 MiB.

Detection - a parser must reject anything not matching all of:

- bytes `0..99` are `plugin.toml` (NUL-padded name field);
- bytes `148..156` are the header checksum (below);
- bytes `257..262` are `ustar\0` and bytes `263..264` are `00` (POSIX ustar magic);
- every member header has typeflag `0` (regular file);
- every header checksum validates (header bytes summed with `148..156` taken as ASCII spaces), stored as 6 octal digits + NUL + space;
- members appear in the order above; the archive ends with two zero blocks.

Reproducibility: `uid=gid=0`, empty `uname`/`gname`, mode `0644`, `mtime=0`, no `prefix`. Two builds of the same plugin produce byte-identical archives; the registry's stored sha256 stays stable and mirrors stay cheap.

Why a bundle, not a single wasm with an embedded manifest: every verifier would need a wasm parser just to find the signed bytes (bigger attack surface, divergent implementations), READMEs/icons would need custom sections, and operators could not inspect the manifest without tooling. ustar is one flat, self-describing container that `tar -tvf` reads anywhere, keeps the signed object a plain member, and ports to object stores unchanged - no symlinks or hard links exist in this format.

## 2. Manifest (`plugin.toml`) - fields and validation

Deliberately **no `[plugin]` table**: all fields live at the top level, exactly as the proxy loader expects. PacketManager adds its own fields to the same table; the proxy ignores keys it does not know, so this is safe and intentional.

Required:

| Field | Type | Rules |
|---|---|---|
| `id` | string | `[a-z0-9_.-]{1,64}`; no leading/trailing `.`; no `..`. No path separator is expressible: the id is a safe directory name, traversal is impossible by construction. |
| `version` | string | Semver 2.0 (`MAJOR.MINOR.PATCH`, optional `-pre` / `+build`). Parsed strictly. |
| `name` | string | Non-empty after trim; <= 128 bytes. |
| `plugin_main` | string | `[A-Za-z_][A-Za-z0-9_.-]{0,63}`; must exist as an export of the wasm (checked at load). |
| `plugin_api` | string | `major.minor`, e.g. `"0.1"` - never `"0.1.0"`. (The spec term `api` maps here; `api` is not a string key because `[api]` owns the name.) |
| `wasm_sha256` | string | 64 lowercase hex; sha256 of the exact `plugin.wasm` member bytes. Packaging refuses to publish without it; this binds the manifest signature to the wasm. |

Optional:

| Field | Type | Rules |
|---|---|---|
| `description` | string | <= 1024 bytes; printable UTF-8, no control chars. |
| `authors` | string list | <= 32 entries; each non-empty after trim, <= 256 bytes. One list, `authors` - there is no separate `authors_list`. |
| `website` | string | `http://` or `https://` prefix required; <= 2048 bytes. |
| `license` | string | <= 64 bytes; SPDX recommended, not enforced. |
| `icon` | string | If present, must equal `"icon.png"` and that member must exist. |
| `permissions` | string list | Non-empty entries, no leading/trailing whitespace, unique; otherwise opaque. Not enforced by the loader today. |
| `min_proxy_version` | string | Semver 2.0 of the proxy build, e.g. `"0.9.0"`. See §6. |
| `depend` / `softdepend` | string list | Hard / ordering-only dependency ids; same charset as `id`; an id in both is rejected. Resolution (Kahn) is the loader's job, not the registry's. |
| `cache_quota_bytes` / `cache_quota_resources` | u64 | Passed to the proxy unchanged. |
| `[locales]` | empty table | Opt-in to `locales/<lang>/<id>.toml` registration. |
| `[api].exports` | table array | `name` per entry, `[A-Za-z_][A-Za-z0-9_.-]{0,63}`, unique. Names only. |

Global rules: manifest <= 64 KiB; TOML must parse; all validation failures are reported together. Semver build metadata never affects the registry layout - version directories use the `MAJOR.MINOR.PATCH[-pre]` core; a version whose core is not filesystem-safe is rejected.

## 3. Index layout on disk

The index **is a directory, not a SQLite database.** Every fact the registry serves is derivable from the files below; `index.json` is rebuilt deterministically from the tree, never edited by hand. Tree disagrees with `index.json` -> the tree wins, `index.json` is regenerated.

```text
<index_root>/
  index.json                          # signed catalog snapshot (canonical JSON)
  index.json.sig                      # ed25519 signature over index.json bytes
  trust-list.toml                     # publisher public keys (§4, §5)
  trust-list.toml.sig                 # ed25519 signature over trust-list.toml bytes
  authenticate-with-totp/             # one directory per plugin id (id charset, §2)
    versions/
      1.0.0/
        authenticate-with-totp-1.0.0.plugin
        authenticate-with-totp-1.0.0.plugin.sig
      1.2.3/
        authenticate-with-totp-1.2.3.plugin
        authenticate-with-totp-1.2.3.plugin.sig
```

File naming: `<id>-<version>.plugin` - the version is the manifest's, so directory name and manifest cannot drift.

Latest-version discovery uses exactly one mechanism: the signed top-level `index.json`. Each `plugins[<id>]` carries `latest` (a version string) and `versions[]` with per-version `version`, `file`, `sha256`, `size`, `plugin_api`, `min_proxy_version`, `published_at`, `signing_key` (fingerprint), `revoked` (§5). No symlinks, no `latest` symlink, no per-directory snapshot, no reader-side directory scanning. Clients make one GET (`/index.json`) and get everything.

Canonical JSON: UTF-8, LF, 2-space indent, keys sorted at every level, no trailing newline - byte-stable across rebuilds, so signatures and content-hash cache keys are stable.

Why not a symlink or per-plugin snapshot: symlinks do not exist in object stores (the index must port to R2-class hosting unchanged) and are a platform hazard on Windows; one signed top-level snapshot gives readers one file to verify and keeps revocation a single rebuild.

## 4. Signature scheme

Each plugin author signs with **their own ed25519 key. There is no Candyriya CA** - the registry root key (below) signs the catalog, never plugin payloads.

- Detached signature, covering exactly the raw bytes of the `plugin.toml` member - no pre-hash, pure Ed25519 over those bytes.
- Inside the bundle it is member `plugin.sig` (§1). The same 64 bytes are served as sibling `<id>-<version>.plugin.sig` in the version directory (§3) - so clients verify before downloading the payload, and auditors verify installed bundles offline. The two are byte-identical: one object, two placements, never two signatures.
- The wasm binds indirectly: `manifest.wasm_sha256` pins the wasm bytes; verifying the signature over the manifest authenticates that digest; hashing the wasm completes the chain. Swapping the wasm requires forging a manifest signature, i.e. the author's key.
- `index.json` is signed by the **registry root key** (`index.json.sig`); `trust-list.toml` is signed by the same key (`trust-list.toml.sig`). The proxy embeds the registry root public key at build time; operators never manage it. The root authenticates the catalog and the key list - author keys still gate plugin payloads.

`trust-list.toml` (the only publisher key store; never per-plugin keys):

```toml
# fingerprint = "sha256:" + hex(sha256(raw 32-byte public key))
# key         = raw 32-byte ed25519 public key, base64 (44 chars, padded)
# values below are a consistent worked example:
#   sha256(base64decode(key)) == the fingerprint's hex digest
[[key]]
fingerprint = "sha256:0ff713bf0101f7e5c6247495ab43ebd577153ee31430cd7590f8930d0c677522"
name = "Alice Example"
key = "AosPW3rjd2XByURWKWLHU5noqKKBTCCqC1pV9eKwYnQ="
added = "2026-11-18"
comment = "authenticate-with-totp maintainer"
```

On every read: fingerprint must equal `sha256:` + hex(sha256(raw key)); duplicates rejected; unknown keys in entries rejected.

Revocation flow: remove the key's `[[key]]` entry from `trust-list.toml` (PR -> merge -> deploy). The next deterministic index rebuild marks every version whose `signing_key` fingerprint left the trust list `"revoked": true`. Consequences, exactly:

1. Publish: a publish signed by that key is rejected.
2. Updates: `-S` refuses any revoked version or any version that fails verification - the update stream stops dead.
3. Fresh installs of an already-published version remain possible, but the CLI warns loudly and records the install as revoked-flagged.
4. Running plugins are never killed or unloaded; the flag surfaces in listings and at next load. Removal is an operator action.

To withdraw one broken release without touching keys, delete its version directory from `<index_root>` and rebuild - downloads 404, the plugin vanishes from `index.json`. Already-installed copies are unaffected (§11).

## 5. Trust model and revocation

- **Who may publish:** anyone whose key is in `trust-list.toml`. The HTTP publish endpoint additionally requires the operator credential (`PM_API_KEY`) against registry abuse, but that credential without a trust-listed key is never sufficient to publish.
- **Who signs:** each author, per bundle, at publish time, with their own key. The registry never re-signs payloads and never holds author private keys.
- **Who vouches for the catalog:** the registry root key, build-pinned in the proxy. Root compromise does not forge payloads (author signatures still gate them); one author key's compromise does not rewrite the catalog.
- **Revocation:** key removal from `trust-list.toml` (§4). Deterministic, total for new publishes, loud-but-advisory for old installs.
- **Did-a-plugin-break fallback:** delete the version directory and rebuild (§4). Installed copies keep running; operators uninstall by removing `plugins/<id>/` and reloading. No remote kill switch exists or is promised.
- **Disputes / policy:** out of scope. This spec covers mechanism, not governance.

## 6. Version compatibility and install refusal

Two gates; both must pass before any bytes are written.

**Gate A - plugin ABI.** Parse `plugin_api` as `major.minor`. Host speaks `H = (h_major, h_minor)` (`0.1` today). Pass iff `plugin_major == h_major && plugin_minor <= h_minor`. A plugin built for `0.2` is refused by a host speaking `0.1`; a plugin built for `0.1` runs on `0.2`. Malformed `plugin_api` fails the install.

**Gate B - proxy build.** If `min_proxy_version` is present, parse it and the running proxy's build version as semver 2.0. Pass iff `proxy_semver >= min_proxy_version`. Absent field: pass.

Algorithm (`candyriya plugins -S` and any other installer):

1. Fetch and verify `index.json` (§4); else abort.
2. Resolve requested id/version (default `latest`); absent -> abort.
3. Read `plugin_api` and `min_proxy_version` from the index entry (copied at publish from the manifest - index/manifest disagreement is a publish bug, never resolved at install time).
4. Gate A; fail -> refuse with `plugin_api_incompatible`.
5. Gate B; fail -> refuse with `proxy_too_old`.
6. Download bundle + `.sig`; verify signature, manifest hash, `wasm_sha256`. Any mismatch refuses and deletes the temp file.
7. Only then atomically move into place and reload.

Worked example: proxy build `0.9.2`, ABI `0.1`; candidate `1.2.3` with `plugin_api = "0.1"`, `min_proxy_version = "0.9.0"`. Gate A: `0 == 0 && 1 <= 1` pass. Gate B: `0.9.2 >= 0.9.0` pass. Install proceeds. Same candidate with `plugin_api = "0.2"` -> refused at Gate A, nothing downloaded. `min_proxy_version = "1.0.0"` -> refused at Gate B, nothing downloaded.

## 7. Lifecycle states

Labels forming the contract for the plugin set's lifecycle. Defined here; implemented elsewhere.

| State | Meaning |
|---|---|
| `DISCOVERED` | Seen on disk or in the index; manifest not yet validated. |
| `LOADED` | Manifest validated; instance (or its absence) recorded; not yet enabled. |
| `ENABLING` | Dependency-resolved set instantiating; `plugin_main` existence checked. |
| `ENABLED` | Live; receives events and calls. |
| `DISABLING` | Shutdown in progress; tasks cancelled, mailbox closed, drain pending. |
| `DISABLED` | Not running; files on disk. A `Failed` record is a `DISABLED` with a reason attached, never a crashed process. |

Transitions: `DISCOVERED -> LOADED -> ENABLING -> ENABLED -> DISABLING -> DISABLED`, plus `ENABLING -> DISABLED` on enable failure and `DISABLED -> ENABLING` for re-enable. Installing (§8) writes files and nudges discovery; it never instantiates anything - the proxy's load path owns state.

## 8. Install paths: laptop to working install

Exactly two paths; both consume the same `.plugin`.

**(a) Manual.** Download `<id>-<version>.plugin` and its `.sig` from the registry or a mirror; verify the signature offline against a cached `trust-list.toml`; unpack with any ustar tool into `<data_dir>/plugins/<id>/` (`plugin.toml` -> `plugin.toml`, `plugin.wasm` -> `<id>.wasm`); `/candyriya reload plugins` or restart. No packet manager runtime; the format is fully self-describing.

**(b) CLI.** `candyriya plugins -S <id>` (optionally `@<version>`): fetch `index.json` + signature, pick the newest non-revoked version (or the exact requested one), run the §6 gates, download bundle + `.sig`, verify, unpack atomically into `plugins/<id>/`, reload plugins. State is the filesystem plus the proxy's reload - no separate package database.

Both paths end in the same bytes and the same reload; no format-level drift between "manual" and "managed" installs.

## 9. Worked example: `authenticate-with-totp-1.2.3.plugin`

Full `plugin.toml` member, exactly as packed (UTF-8, LF, trailing newline):

```toml
id = "authenticate-with-totp"
version = "1.2.3"
name = "Authenticate with TOTP"
description = "Adds RFC 6238 TOTP two-factor login to the candyriya proxy."
authors = ["Alice Example <alice@example.com>"]
website = "https://github.com/example/authenticate-with-totp"
license = "MIT"
plugin_main = "on_event"
plugin_api = "0.1"
min_proxy_version = "0.9.0"
permissions = ["players.read"]
wasm_sha256 = "9a3f2c1b7e58d04f6a91c8b2d5e70318f4a6c905b1d2e7f8395a4c0b6d8e12f"
```

`sha256` of those 464 bytes (what `plugin.sig` covers): `fca0a2bb14847af264bee345edd5a7e36502c588d6f3478fcd12b00e32c2590e`.

Archive layout (offsets decimal, header sizes octal):

```text
0      member 1 header - name "plugin.toml", typeflag '0', size 0710 (464),
       "ustar\0" at 257, valid checksum
512    plugin.toml data (464 B), NUL-padded to 512-byte blocks
1488   member 2 header - name "plugin.wasm", size 0432364 (144628)
...      plugin.wasm data, padded to 512-byte blocks
...      member 3 header - name "plugin.sig", size 0100 (64)
...      plugin.sig data (64 B ed25519 over the plugin.toml bytes), padded
...      member 4 header - name "README.md" (optional)
...      README.md data, padded
end-1k two zero blocks (end of archive)
```

Member names are exactly the fixed set from §1. `plugin.sig` next to the bundle is byte-identical to the `plugin.sig` member. `README.md` documents TOTP enrollment for server owners. The manifest digest is a real sha256 of the member as printed (LF endings); `wasm_sha256` shows the field's format. Tooling recomputes digests from the artifact and never trusts printed values.

## 10. Plugin messaging channels and future `call_api`

The existing plugin messaging surface is unchanged. `bungeecord:main` and `candyriya:main` remain the only plugin messaging channels; this format renames them never and adds nothing to their wire protocol - a plugin that speaks messaging today ships in a `.plugin` unchanged. The registry neither inspects nor routes messaging traffic.

A future `call_api(plugin_id, fn_name, args)` host function (plugin-to-plugin calls routed by the host against `[api].exports`) is explicitly out of scope here. `[api].exports` is carried in the manifest for forward compatibility only; this document promises nothing about when or whether `call_api` lands, and no `.plugin` may assume it exists.

## 11. Security assumptions

Future agents and operators must internalize these, in order:

1. **The `.plugin` file is untrusted.** Mirror, cache, laptop, or attacker - it is used only after the §4 chain verifies: `index.json.sig` -> trust list -> `plugin.sig` -> manifest -> `wasm_sha256` -> wasm. No step is ever skipped, short-circuited, or "temporarily" disabled. Tests use throwaway keys generated in-test, never the real trust list.
2. **The index is untrusted.** `index.json` (and cached copies) is used only after `index.json.sig` verifies against the embedded registry root key. A stale-but-valid cached index may be used offline - it must carry its signature. No verifiable index -> installs stop; never "install anyway".
3. **The offline cache is untrusted storage.** Cached verified bundles are re-verified on every use, not only at cache-write time. Poisoning is detected, not prevented.
4. **TLS is transport, not trust.** HTTPS protects bytes in motion; never a substitute for signature verification, and nothing here authorizes one.
5. **Revocation is flagging, not unloading.** A revoked plugin can still run and still be installed (with warnings). Removal is an operator action; nothing reaches into a running proxy.
6. **No bypass exists.** No config key, environment variable, or CLI flag in this specification disables signature verification. Any future proposal to add one is a security regression, not a convenience.
