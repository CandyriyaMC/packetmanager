# Security Policy

## Supported versions

The current `dev` branch is supported. Tagged `v*` releases are supported for
90 days from the release date with security backports where feasible.

## Reporting a vulnerability

**Do not open a public issue.** Report vulnerabilities privately:

- Email: <mailto:security@candyriya.xsxs.lol>
- GitHub: use the "Report a vulnerability" link on the Security tab

A real private mailbox for this service will be published before public
launch of the hosted instance; until then the email above reaches the
maintainer.

## What is in scope

- Authentication bypass on `/api/v1/plugins/publish`
- Plugin bundle parser / path traversal on `download`
- Unauthenticated resource exhaustion
- Supply-chain issues in published bundles (forged signatures, MITM)
- Secret leakage in logs, error bodies, or audit trails

## What is out of scope

- Plugin authors deliberately uploading malicious bundles — user discretion and the publishing pipeline (Phase 2: signed publishers) mitigate that
- Operator self-hosting misconfiguration
- Denial of service against the public instance at capacity

## Coordinated disclosure

We aim to acknowledge reports within 72 hours. Remediation targets within
7 days for critical issues and 30 days for the rest. We will credit
reporters (if desired) in the release notes and this changelog.
