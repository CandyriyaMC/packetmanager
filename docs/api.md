# PacketManager HTTP API (v1)

This is the HTTP API for Candyriya PacketManager, the public plugin registry and
distribution service. Two audiences:

- **plugin authors** — you want to publish one plugin and download it back;
- **operators** — you want to know exactly what the wire contract is, so your
  tooling, CI, or proxy can talk to the registry without guessing.

It describes **version 1** of the API. See [Versioning](#versioning) at the
bottom for how v2 will be served.

> **Contract vs. current server.** This document is the v1 contract. The
> server is being built toward it in phase 1, and the bootstrap already
> implements most of it. Where the current server deviates, the deviation is
> called out inline as *Current server:*. If you write code against this doc,
> write against the contract, not the deviations.

## Conventions

- Everything is **JSON, UTF-8**, unless a response says otherwise (download
  returns raw bytes, metrics returns Prometheus text — both are labeled).
- Request bodies that carry JSON are sent with
  `Content-Type: application/json`. The server checks the body against the
  declared schema before the handler runs; a missing, malformed, or
  schema-violating body is rejected with a 4xx and nothing is written to disk.
- Send exactly the fields documented per endpoint. Strict schemas: unknown
  fields are not part of the contract, do not rely on them being accepted or
  ignored.
- **Consumers MUST validate the `Content-Type` of responses before trusting
  the body.** Error bodies are always `application/json`; the download
  endpoint is not; metrics is not. If the content type is not what the
  endpoint documents, treat the body as untrusted and fail.
- Errors are JSON with the shape `{ "ok": false, ... }` — see
  [Errors](#errors). Success responses vary per endpoint; `ok: true` is not
  universal (list/detail/download/health/ready are plain bodies without an
  `ok` envelope).
- `x-api-key`: required **only** for `POST /api/v1/plugins/publish`. Every
  other endpoint in this document is anonymous today. Send the key as a plain
  header: `x-api-key: <your key>`. If the server was started without
  `PM_API_KEY`, publish is unauthenticated (dev mode, a warning is logged) —
  do not build tooling that depends on that.
- Base URLs, ports, and hostnames are deployment details and are not pinned
  here. All examples use `https://registry.example.com` for readability.
- Timestamps are ISO 8601 UTC (`2026-11-18T12:34:56.789Z`).

## POST /api/v1/plugins/publish

Publishes one plugin bundle. Authenticated with `x-api-key`.

**Request**

```http
POST /api/v1/plugins/publish HTTP/1.1
Content-Type: application/json
x-api-key: your-key-here

{
  "id": "example-plugin",
  "name": "example-plugin",
  "version": "1.0.0",
  "module": "AGFzbQEAAAA="
}
```

| field     | type   | required | rules |
|-----------|--------|----------|-------|
| `id`      | string | yes | `^[a-z0-9_-]{1,64}$` — lowercase, no dots |
| `name`    | string | yes | `^[a-z0-9][a-z0-9.-]{0,127}$`, case-insensitive |
| `version` | string | yes | `MAJOR.MINOR.PATCH`, optional `-prerelease`, semver |
| `module`  | string | yes | base64-encoded bytes of the `.plugin` bundle |

`module` carries the `.plugin` bundle (today: raw WebAssembly bytes):

- **base64 is the canonical and preferred encoding.** The current server
  accepts **only** base64 here — it is decoded with a standard base64 decoder
  and the resulting bytes are stored verbatim. That is the one thing you can
  rely on today.
- A raw-binary (non-JSON, `application/octet-stream`) upload is **not
  accepted today**: the body schema requires a JSON string, and raw bytes do
  not parse. It may be added later as an additive, minor-release change;
  base64 will remain preferred because the publish body is JSON by contract.

**Response — success: `200 OK`**

```json
{ "ok": true, "plugin": { "id": "example-plugin", "version": "1.0.0" } }
```

Note what is **not** echoed: the bundle itself, `publishedAt`, or `name`.
Poll `GET /api/v1/plugins/:id` if you need the stored record.

**Response — validation failure: `400 Bad Request`**

```json
{ "ok": false, "findings": ["invalid id", "invalid semver"] }
```

Known `findings` values: `invalid id`, `invalid name`, `invalid semver`,
`module bytes required`. The list contains every failed check, not just the
first. *Current server:* bad-input responses omit the `reason` field entirely;
treat a 400 with a non-empty `findings` array and no `reason` as `bad-input`
(see [Errors](#errors)).

**Response — auth failure: `401 Unauthorized`**

```json
{ "ok": false, "reason": "unauthorized" }
```

*Current server:* re-publishing an existing `id`+`version` silently
**overwrites** the stored bundle and manifest. There is no `duplicate`
rejection yet. Assume overwrite; do not re-publish a version you care about
keeping.

## GET /api/v1/plugins

Lists all published plugins. Anonymous.

```http
GET /api/v1/plugins HTTP/1.1
```

**Response — `200 OK`**, `application/json`: a JSON array of plugin summary
objects, one per published plugin, sorted by `id` ascending:

```json
[
  { "id": "alpha-tools", "name": "alpha-tools", "version": "1.2.0" },
  { "id": "zeta-utils",  "name": "zeta-utils",  "version": "0.9.1" }
]
```

- Each element has exactly `id`, `name`, `version` (all strings).
- Sort order: ascending by `id`. *Current server:* the sort uses the runtime
  default `localeCompare`, which is locale-dependent — for plain ASCII ids
  `a`..`z` the result matches code-unit order. Do not depend on the relative
  order of ids that differ only by case or locale-specific glyphs.
- Empty registry returns `[]`, not an error.
- Plugin directories that cannot be read are silently skipped — a 200 with a
  missing entry means "not readable", not "not published".

## GET /api/v1/plugins/:id

Returns the detail record for one plugin. Anonymous.

**Request**

```http
GET /api/v1/plugins/example-plugin HTTP/1.1
```

**Response — `200 OK`**

```json
{
  "id": "example-plugin",
  "name": "example-plugin",
  "version": "1.0.0",
  "publishedAt": "2026-11-18T12:34:56.789Z",
  "module": "AGFzbQEAAAA="
}
```

| field         | type   | notes |
|---------------|--------|-------|
| `id`          | string | as published |
| `name`        | string | as published |
| `version`     | string | semver |
| `publishedAt` | string | ISO 8601 UTC, set at publish time |
| `module`      | string | base64 of the `.plugin` bundle, verbatim as published |

*Current server:* the detail response echoes the full base64 `module` —
potentially megabytes of JSON for every detail call. Clients that only need
metadata MUST NOT depend on `module` being present, because this is expected
to be dropped from the detail schema in a minor revision. Fetch the bundle
via `GET /api/v1/plugins/:id/download` instead.

**Response — unknown id:** the contract is `404 Not Found` with
`{ "ok": false, "reason": "not found", "findings": [] }`, matching the
download endpoint. *Current server:* returns `200 OK` with a literal `null`
body for unknown ids. Clients must not treat `null` as a plugin record;
check the body shape before use.

## GET /api/v1/plugins/:id/download

Returns the raw bytes of the stored `.plugin` bundle. Anonymous.

```http
GET /api/v1/plugins/example-plugin/download HTTP/1.1
```

**Response — `200 OK`**

- `Content-Type: application/wasm` (the bundle is wasm bytes today).
- The body is the raw bundle, byte-for-byte as published. Do not parse it as
  JSON.
- `Content-Disposition: attachment; filename="example-plugin-1.0.0.plugin"` —
  the contract for saving to disk. *Current server:* this header is **not**
  set today; clients must not rely on it for filenames until it lands.

Verify the `Content-Type` before treating the body as a bundle. If the
response is JSON with `ok: false`, it is an error body, not a bundle.

**Response — unknown id: `404 Not Found`**

```json
{ "ok": false, "reason": "not found" }
```

`Content-Type: application/json`. This is the canonical `not found` error.

## GET /health

Liveness probe. Point your load balancer / container runtime at it.

```http
GET /health HTTP/1.1
```

**Response — `200 OK`, always**

```json
{ "status": "ok" }
```

`always 200` means: if you get a non-2xx from this endpoint, the process is
not serving at all (crash loop, wrong port, proxy in front eating the path).
It says nothing about storage.

## GET /ready

Readiness probe.

```http
GET /ready HTTP/1.1
```

**Response — `200 OK`**, only when storage is writable:

```json
{ "status": "ready" }
```

**Response — `503 Service Unavailable`**, same body shape, when storage is
not writable (disk full, permissions, volume unmounted). The body stays
`{ "status": "ready" }`-shaped but reports readiness state; check the status
code, not the body, to gate traffic.

*Current server:* `/ready` always returns `200` and does **not** check
writability. Until that lands, a 200 does not guarantee the registry can
accept publishes.

## GET /metrics

Prometheus exposition, `text/plain; version=0.0.4; charset=utf-8`.
Anonymous; scrape from inside the cluster/VPC, not the public internet.

**Response — `200 OK`**

```text
# HELP packetmanager_http_requests_total Total HTTP requests by endpoint, method and status.
# TYPE packetmanager_http_requests_total counter
packetmanager_http_requests_total{endpoint="/api/v1/plugins",method="GET",status="200"} 42
packetmanager_http_requests_total{endpoint="/api/v1/plugins/publish",method="POST",status="401"} 3
```

Per-request metrics carry one label set — the `{ endpoint, method, status }`
subject shape:

```text
{ endpoint: "/api/v1/plugins", method: "GET", status: "200" }
```

- `endpoint`: the route pattern, not the raw path — `/api/v1/plugins/:id`,
  not `/api/v1/plugins/example-plugin`. This keeps cardinality bounded.
- `method`: upper-case HTTP method.
- `status`: the response status code, as a string.

*Current server:* `/metrics` is specified by the phase-1 epic but not
implemented yet; the current server has no metrics endpoint. When it lands,
the format above is the contract, and the `.subject` label shape stays
`{ endpoint, method, status }`.

## Errors

Error bodies are `application/json` and share one schema:

```json
{ "ok": false, "reason": "bad-input", "findings": [] }
```

| field      | type     | meaning |
|------------|----------|---------|
| `ok`       | boolean  | always `false` |
| `reason`   | string   | machine-readable cause code, see table below |
| `findings` | string[] | per-check detail; may be empty for non-validation errors |

Always present as a pair: `reason` for routing, `findings` for humans/CI.
New cause codes may be added in minor releases; clients must treat unknown
reasons as generic failures, not crash.

| reason        | HTTP | meaning | current server |
|---------------|------|---------|----------------|
| `bad-input`   | 400  | body failed schema/validation | emitted with `findings`, but **without** `reason` — see below |
| `unauthorized`| 401  | missing/wrong `x-api-key` on publish | emitted today, no `findings` |
| `not found`   | 404  | unknown plugin id on download (and, by contract, on detail) | emitted on download today |
| `duplicate`   | 409  | same `id`+`version` already published | reserved; **not emitted today** — publish overwrites |
| `upstream-fail` | 502 | a dependency failed (storage backend, signing when it lands) | reserved; **not emitted today** |
| `internal`    | 500  | uncaught server error | reserved; uncaught errors surface as framework 5xx today |

One example body per cause code:

```json
{ "ok": false, "reason": "bad-input", "findings": ["invalid semver"] }
{ "ok": false, "reason": "unauthorized", "findings": [] }
{ "ok": false, "reason": "not found", "findings": [] }
{ "ok": false, "reason": "duplicate", "findings": ["id+version already published"] }
{ "ok": false, "reason": "upstream-fail", "findings": ["storage write failed"] }
{ "ok": false, "reason": "internal", "findings": [] }
```

Normalization notes for clients written against the current server:

- A `400` with non-empty `findings` and no `reason` == `bad-input`.
- A `401` always means `unauthorized`.
- A `404` on download always means `not found` (exact casing, two words).
- Do not string-match `findings` across releases — the values are
  human-facing detail, not stable codes. Match `reason` (and the HTTP
  status), not `findings`.

## Versioning

This document describes **API v1**.

- The v1 contract changes **only at a major revision**. Additive changes
  (new optional fields, new endpoints, new cause codes) may land in v1 minor
  releases without bumping the major version.
- When v2 lands, it will be a **separate document** and must be read from
  `/?major` with the major version as the query parameter — i.e. v2 will be
  served as the v2 doc at `/?major=2`, and this v1 doc remains available
  unchanged for existing integrations.
- Pin your integration to this document, not to whatever the latest revision
  says. If you read `/?major=1` and the server contradicts it, that is a bug;
  report it.

## Appendix: endpoint summary

| method | path                        | auth       | body on success                |
|--------|-----------------------------|------------|--------------------------------|
| GET    | `/health`                   | anonymous  | `{ "status": "ok" }`           |
| GET    | `/ready`                    | anonymous  | `{ "status": "ready" }`        |
| GET    | `/metrics`                  | anonymous  | Prometheus text                |
| GET    | `/api/v1/plugins`           | anonymous  | `[{ id, name, version }, ...]` |
| GET    | `/api/v1/plugins/:id`       | anonymous  | detail record                  |
| GET    | `/api/v1/plugins/:id/download` | anonymous | raw `.plugin` bytes         |
| POST   | `/api/v1/plugins/publish`   | `x-api-key`| `{ ok: true, plugin }`         |
