# Contributing to Mako

Thanks for helping. Mako is a pnpm monorepo: `api/` (Hono + MongoDB), `app/`
(React/Vite), `packages/*` (published SDK/CLI, schemas, desktop), `docs/`,
`website/` lives in the marketing repo.

## Setup

```bash
pnpm install
cp .env.example .env      # see CLAUDE.md for what each variable does
pnpm dev                  # API :8080, app :5173, Inngest dev server
```

## Working rules

- Read `CLAUDE.md` and `.cursor/rules/` first — they are the canonical
  engineering rules (workspace scoping, auth order, no `any`, structured
  logging, query cancellation).
- Every API route change: `pnpm openapi:sync` (the typed client and the
  contract CI depend on it).
- Tests: `pnpm --filter api test`, `pnpm --filter app test`; `node --test` in
  `packages/app-sdk` and `packages/cli`.
- Pre-commit runs lint-staged (eslint + prettier). Keep commits scoped; PR
  titles follow `type(scope): summary`.

## Pull requests

Open a PR against `master` with a short "why / what / verified" body. CI must
be green (lint, OpenAPI contract, preview deploy). A maintainer reviews within
a few days.

## Licensing

By contributing you agree that your contributions are licensed under the
Apache License 2.0 (see `LICENSE`).
