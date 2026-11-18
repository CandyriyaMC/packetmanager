# Candyriya PacketManager

Plugin registry and distribution service for Candyriya: the public index of
signed plugins that operators can install and update through the proxy.

Candyriya PacketManager accepts plugin packages (`.plugin` bundles, versioned
sematically) for Java/versions-like games, validates and signs them, serves the
public index over HTTP, and verifies compatibility against the running proxy's
plugin API level.

## Design

- **Bun + Elysia** — same runtime stack as the proxy ecosystem; small, fast,
  type-safe server. No runtime dependencies beyond Elysia and Bun itself.
- **HTTP API only** — no HTML frontend, no server-side rendering; the registry
  is a data service. Docs are Markdown, served from `docs/` as-is.
- **Stateless core** — a directory or R2 bucket of signed plugin bundles; the
  index is rebuilt deterministically from the set of shipped plugin records.
- **Signatures required** — one signing key signs the release index; individual
  plugins may be verified via a per-plugin public key list.

## Scoping

- Phase 1: working endpoints for signed plugin fetch, index query, and health.
- Phase 2: user-authored plugin publishing pipeline.
- Phase 3: GUI on top if there is a real need; never blocking operators.

## Licensing

This project is dual-licensed under MIT OR Apache-2.0, matching the rest of
Candyriya.
