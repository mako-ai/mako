# Security policy

Mako connects to production databases, so we treat security reports as the
highest-priority work we have.

## Reporting a vulnerability

Email **security@mako.ai** with a description, the affected component
(`api`, `app`, `packages/*`, the hosted service at app.mako.ai, or the MCP
server), reproduction steps, and your assessment of impact. Please do not open
a public issue for security problems.

You will get an acknowledgement within 2 business days and a fix or mitigation
plan within 10 business days for confirmed high-severity issues. We will credit
you in the release notes unless you prefer otherwise.

## Scope

- This repository and the packages published from it (`@makoai/app-sdk`,
  `@makoai/cli`, `mako-ai` on PyPI).
- The hosted service at https://app.mako.ai, including `POST /api/mcp`.

Out of scope: vulnerabilities in third-party services we integrate with
(report those to the vendor), and issues that require a compromised user
account or device.

## What we do on our side

- Warehouse credentials are encrypted at rest (AES-256) and never leave the
  API; agents and apps only ever see query results.
- MCP access is read-only by default; writes need scoped keys a workspace admin
  creates deliberately (see `AUTH_README.md`).
- Dependencies are updated by Dependabot; releases to npm and PyPI use trusted
  publishing (OIDC) — there are no long-lived publish tokens.
