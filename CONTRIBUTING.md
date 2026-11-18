# Contributing to Candyriya PacketManager

Thanks for your interest in contributing! This document covers the basics:
building the project, what we expect from pull requests, and how decisions
are made here.

## Building from source

```shell
git clone https://github.com/CandyriyaMC/packetmanager.git
cd packetmanager
bun install
bun run dev
```

The server listens on `http://localhost:8093` by default (override with
`PORT`). `$PM_DATA_DIR` controls where the package index lives (default:
`./data`); `PM_API_KEY` gates the `POST /api/v1/plugins/publish` endpoint.

## Running the checks

```shell
bun test
bun run typecheck
bun run lint   # when configured
```

## Style guide

- **TypeScript, no `any`.** Strict mode. Prefer small, typed functions.
- **No comments mention anything from the notes/private OS folder.**
  Comments are English, informal, document *why*, not *what*.
- **The HTTP contract is the public surface.** Breaking changes need a
  major version bump and a SECURITY.md disclosure window.
- **No mocks/stubs/placeholder-code.** Real endpoints only.

## Branching model

- `dev` is the integration branch. Feature branches squash-merge into `dev`.
- `main` tracks the released state. PRs from `dev` into `main` cut releases.
- PRs target `dev`, not `main`.
- Direct pushes to `main` are blocked; everything goes through a PR.

## Pull requests

- **Squash-only.** Keep the final commit message meaningful.
- One logical change per PR.
- CI must be green before review.
- By contributing, you agree your contributions are licensed under GPL-3.0.

## Reporting bugs and requesting features

Use the issue templates. For **security** issues go to SECURITY.md instead —
never file a public issue.

## Code of Conduct

This project follows the Contributor Covenant. Be kind, helpful and honest.
