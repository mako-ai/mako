# Mako user journey · TesterArmy e2e

Uses [TesterArmy e2e](https://tester.army/e2e), its Playwright engine and the
official skill at `.agents/skills/e2e/SKILL.md`. Node >=22.12 is required.
The lockfile pins the tested runner/engine (exact versions in `package.json`).
The pinned engine uses `pnpm exec playwright install --with-deps chromium`.
Dependency updates must respect the repository's 24-hour minimum release age.
The browser is driven by `agent.act` goals through Vercel AI Gateway. Exact UI,
API and SQL assertions verify the agent's outcomes. Only the exact SQL text is
entered directly into Monaco; the agent opens the console, selects its connection
and executes the query. Credentials and email codes use TesterArmy's opaque secrets.

```sh
pnpm install --frozen-lockfile
pnpm test:e2e --headed
```

The suite creates a new Mako account and workspace on every run, connects a
database, links a GitHub repository, sends a chat, and executes read-only
SQL. It does not seed an admin, deploy, or clean up other users' data. It
does not delete its own account either, so only loopback hosts are accepted;
PR previews and other shared hosts stay blocked until the suite cleans up
after itself. Do not target production or a customer repository.

The eight serial checks follow the current UI order: register and verify
email → create workspace → answer the four quiz questions → connect the demo
Postgres database → connect GitHub → link the selected repository → send a
chat and check the reply → execute SQL and check the result cells. Onboarding
requires a database before the user can access GitHub settings.

## Modes

**Isolated (CI default):** `MAKO_E2E_START_APP=1` with
`MAKO_E2E_GITHUB_AUTH=fake`. The runner starts the Mako API, Vite and
`tests/e2e/fake-services.ts`, a loopback stand-in for GitHub's REST API and
the Vercel AI Gateway. Mako receives only fake values: a throwaway App key
generated per run (it signs JWTs for the fake), a fake App ID/slug/client ID,
`GITHUB_API_BASE_URL` and `AI_GATEWAY_BASE_URL` pointing at the fake, and a
placeholder AI key. Real GitHub App or AI credentials in the environment are
never forwarded to Mako; the app command only receives the variables listed in
`e2e.config.ts`. Only localhost and a loopback MongoDB named `mako_e2e` are
accepted. The runner waits for the fakes' `/ready` probe, which answers only
once the Vite app and the API answer too.

**Existing server:** `MAKO_E2E_START_APP=0` (default) with
`MAKO_E2E_GITHUB_AUTH=oauth` (default) runs against an already started
dedicated local instance. Other hosts are rejected. That server's own GitHub, email, demo database and
AI configuration are used; no server secrets are copied locally.

## Configuration

Copy `.env.e2e.example` to the ignored `.env.e2e.local`.

| Variable                              | Purpose                                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `MAKO_E2E_BASE_URL`                   | Mako URL; defaults to `http://127.0.0.1:5173`.                                                                  |
| `MAKO_E2E_START_APP`                  | `1` starts/stops Mako and the loopback fakes through the runner; default `0` uses an existing server.           |
| `MAKO_E2E_GITHUB_AUTH`                | `fake` (required with `MAKO_E2E_START_APP=1`) or `oauth` (default) for real OAuth on an existing server.        |
| `AI_GATEWAY_API_KEY`                  | Browser agent only. Not needed to replay `.e2e/cache`; needed to record or on a cache miss. Use a budgeted key. |
| `MAKO_E2E_MODEL`                      | Agent model; defaults to `openai/gpt-6-luna-fast`.                                                              |
| `MAKO_E2E_MONGODB_URI`                | Isolated loopback MongoDB replica set named **mako_e2e**: reads the email code and writes the fake fixture.     |
| `MAKO_E2E_EMAIL`, `MAKO_E2E_PASSWORD` | Optional fresh identity for OAuth runs; fake mode generates a new email per attempt.                            |
| `MAKO_E2E_GITHUB_STATE`               | OAuth mode: Playwright storage state of a dedicated GitHub test account. Only github.com cookies are used.      |
| `MAKO_E2E_GITHUB_REPO`                | OAuth mode: `owner/repo` of a disposable test repository. Fake mode uses the fake's repository.                 |

Isolated mode also needs `DEMO_DATABASE_URL` (dedicated PostgreSQL; the final
query is `SELECT 19 + 23 AS mako_e2e_answer`), `SESSION_SECRET`,
`ENCRYPTION_KEY`, `APPS_GIT_ROOT` and `APPS_SESSIONS_ROOT`; see the workflow.

## GitHub and AI fakes

CI does not automate GitHub's personal login, and it holds no GitHub App key.
In fake mode, test 05 binds the fake's App installation only to the freshly
created user's workspace in local `mako_e2e`, and blocks navigation to
`github.com/login`. Mako's own sync-URL, installation status, App JWT and
installation-token minting, repository picker and repository link code paths
still run, against the fake. Test 05 is named **CI fixture; excludes OAuth** in
reports; a CI pass is not a claim that GitHub browser authentication passed.
This follows the [Playwright guidance on third-party dependencies](https://playwright.dev/docs/best-practices#avoid-testing-third-party-dependencies).

Mako chat's model is the fake AI Gateway, which answers the journey's
arithmetic question. Test 07 therefore checks Mako's chat pipeline (request,
streaming, rendering), not a third-party model's answer.

### Real OAuth check (existing server)

Use a dedicated GitHub identity that has already authorized that server's Mako
App, installed only on the disposable test repository. Save its session with
Playwright (finish login yourself, then close the browser):

```sh
pnpm exec playwright codegen --save-storage=.e2e/github-state.json https://github.com
```

Set `MAKO_E2E_GITHUB_STATE=.e2e/github-state.json`. Expired sessions, missing App
consent, or missing repository access fail the check.

## Results and limits

`pnpm test:e2e:check` checks TypeScript. `pnpm test:e2e:list` lists the checks.
The JSON report is `.e2e/report.json`. The runner suppresses screenshots after a
secret has been entered. Reports, browser state and local credentials are ignored
by Git. Reviewed replay recordings in `.e2e/cache/` are committed, as recommended
by the [replay guide](https://e2e.tester.army/docs/cache). Dynamic email/workspace
values use `unique()` so replay substitutes a fresh identity. Passwords and OTPs
are opaque secret references, not literal values in recordings.

The runner uses its documented defaults: read-write cache locally; read-only
cache, one worker, one retry and traces on the first retry in CI. Each agent step
is bounded to 25 actions/model calls, with a five-minute test deadline. A cache
miss or stale recording falls back to the live agent, which fails without
`AI_GATEWAY_API_KEY`. Reports distinguish replay from model calls; an 8/8 replay
pass is not evidence of fresh AI planning. A failed serial step skips its
dependants; check the passed/failed/skipped counts.

## GitHub Actions

`.github/workflows/e2e-journey.yml` runs on pull requests, pushes to `master` and
manual dispatch, with read-only `contents` permission, SHA-pinned Actions,
exact image and pnpm versions (pnpm 9, as in the other frontend CI jobs), frozen
dependencies, local MongoDB/PostgreSQL and the loopback fakes.

**Normal runs use no repository secrets.** They replay the committed recordings
with the fakes, so fork pull requests are safe to run. They pass
`--strict-cache`: a recording that no longer replays fails as `REPLAY_STALE`
(exit 2) instead of falling back to the keyless live agent; re-record it.

**Recording** (`workflow_dispatch` with `record_cache=true`) additionally reads
one secret, `E2E_AI_GATEWAY_API_KEY`: a Vercel AI Gateway key with a spend
budget, dedicated to this job. It is passed to the test runner only (never to
Mako) and the run fails early with a clear message if it is missing. Download the
`mako-e2e-cache` artifact, review its actions and literal typed values, then
commit the reviewed files. Locally, run with the default read-write cache and a
budgeted `AI_GATEWAY_API_KEY`, inspect the changed `.e2e/cache/` files and commit
them.

Reports and runner-redacted browser diagnostics upload for seven days unless the
run is cancelled. Browser state, `.e2e/sessions` and app logs are never uploaded.
