# Mako user journey · TesterArmy e2e

Uses [TesterArmy e2e](https://tester.army/e2e), its Playwright engine and the
official skill at `.agents/skills/e2e/SKILL.md`. Node >=22.12 is required.
The lockfile pins the tested runner/engine. The current engine uses
`pnpm exec playwright install --with-deps chromium`; newer documentation uses
`e2e-web install`, introduced after this pinned engine. Dependency updates must
respect the repository's 24-hour minimum release age.
The browser is driven by `agent.act` goals through Vercel AI Gateway. Exact UI,
API and SQL assertions verify the agent's outcomes. Only the exact SQL text is
entered directly into Monaco; the agent opens the console, selects its connection
and executes the query. Credentials and email codes use TesterArmy's opaque secrets.

```sh
pnpm install --frozen-lockfile
pnpm test:e2e --headed
```

Run against an already started **dedicated local development instance** or a
**Mako PR preview** (`https://pr-<number>.mako.ai`). Other hosts are rejected.
The suite creates a new Mako account and workspace on every run, connects a
database, links a GitHub repository, sends a real chat, and executes read-only
SQL. It does not seed an admin, mock successful API responses, deploy, or
clean up other users' data. Do not target production or a customer repository.

The eight serial checks follow the current UI order: register and verify
email → create workspace → answer the four quiz questions → connect the demo
Postgres database → connect GitHub → link the selected repository → send a
chat and check the reply → execute SQL and check the result cells. Onboarding
requires a database before the user can access GitHub settings.

## Configuration

Copy `.env.e2e.example` to the ignored `.env.e2e.local`. These variables are
for the runner. By default, start Mako separately using `CLAUDE.md`. With
`MAKO_E2E_START_APP=1`, TesterArmy starts/stops the API and Vite through
`app.command`; provide the API variables listed in `e2e.config.ts` explicitly.
The command only forwards that allowlist and requires local `mako_e2e`.

| Variable                              | Purpose                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MAKO_E2E_BASE_URL`                   | Running Mako URL; defaults to `http://localhost:5173`.                                                                   |
| `MAKO_E2E_START_APP`                  | `1` starts/stops Mako through the runner; default `0` uses an existing server.                                           |
| `AI_GATEWAY_API_KEY`                  | Vercel AI Gateway authentication for the browser agent; required locally even when testing a preview.                    |
| `MAKO_E2E_MODEL`                      | Agent model; defaults to `openai/gpt-6-luna-fast`.                                                                       |
| `MAKO_E2E_MONGODB_URI`                | Isolated loopback MongoDB replica set named **mako_e2e**: reads the email code; CI also writes the installation fixture. |
| `MAKO_E2E_EMAIL`, `MAKO_E2E_PASSWORD` | Optional fresh OAuth test identity; installation mode generates a new email per attempt. Keep SendGrid disabled locally. |
| `MAKO_E2E_GITHUB_AUTH`                | `oauth` (default) for real OAuth; `installation` for the isolated CI fixture.                                            |
| `MAKO_E2E_GITHUB_STATE`               | Path to a Playwright storage-state JSON from a dedicated GitHub test account. Only github.com cookies are restored.      |
| `MAKO_E2E_GITHUB_REPO`                | Exact `owner/repo` of an existing disposable test repository accessible to the Mako GitHub App.                          |
| `MAKO_E2E_VERIFICATION_FILE`          | For previews: ignored JSON file containing the fresh identity and its real emailed code.                                 |

The Mako API needs `DEMO_DATABASE_URL` pointing at a dedicated PostgreSQL
database. The final query is `SELECT 19 + 23 AS mako_e2e_answer`; no Chinook
tables or production data are needed. Configure `DATABASE_URL` with the same
`mako_e2e` URI used by the runner, and keep `BILLING_ENABLED=false` locally.
The API's GitHub App ID, slug, key and OAuth client configuration must be set
for the GitHub steps. Keep `APPS_CONNECTED_REPO_PUSH` unset in development.

## PR preview

Use a fresh email address that receives mail and set `MAKO_E2E_EMAIL` explicitly.
Set `MAKO_E2E_VERIFICATION_FILE=.e2e/verification.json`. When registration sends
the email, write `{ "email": "the exact test address", "code": "123456" }` with
the actual code to that file (write a temporary file then rename it atomically).
The runner waits up to two minutes and rejects codes for another identity.
Never commit this file. Preview runs use the preview server's existing GitHub,
email, demo database and AI configuration; no server secrets are copied locally.

The runner needs `AI_GATEWAY_API_KEY` to drive the browser agent. The Mako API
also needs its own `AI_GATEWAY_API_KEY` for the real chat assertion. The
preview run creates only its fresh test user/workspace and uses read-only SQL.

## GitHub authentication modes

`MAKO_E2E_GITHUB_AUTH=oauth` (default) exercises the real browser OAuth flow.
`MAKO_E2E_GITHUB_AUTH=installation` is for isolated CI only: it derives the real
installation from the configured GitHub App and test repository, checks its App
ID/account/status, and inserts that installation only into the freshly created
user's workspace in local `mako_e2e`. It does not seed or verify the user.
The fixture is refused on previews, remote MongoDB hosts and other database names.

In CI, navigation to GitHub's personal login is blocked. Mako's sync-URL/status
endpoints, repository picker, repository link, chat and query remain real. Test
05 is explicitly named **CI fixture; excludes OAuth** in reports; a CI pass is
not a claim that GitHub browser authentication passed. This follows the
[Playwright guidance on third-party dependencies](https://playwright.dev/docs/best-practices#avoid-testing-third-party-dependencies).

### Real OAuth check

Use a dedicated GitHub identity that has already authorized the configured
Mako App, installed only on the disposable test repository. Save that identity's
session with Playwright (finish login yourself, then close the browser):

```sh
pnpm exec playwright codegen --save-storage=.e2e/github-state.json https://github.com
```

Set `MAKO_E2E_GITHUB_STATE=.e2e/github-state.json`. The test clicks Mako's
**Connect GitHub repository** button; Mako's real OAuth popup discovers the
installation and the test verifies it through the authenticated status API.
The next step selects the exact repository in the UI and verifies it survives
a reload. Expired sessions, missing App consent, or missing repository access
fail the check; they are never replaced with a fabricated installation.

## Results and limits

`pnpm test:e2e:check` checks TypeScript. `pnpm test:e2e:list` lists the checks.
The JSON report is `.e2e/report.json`; failures include the step and artifact
paths. The runner suppresses screenshots after a secret has been entered.
With the pinned runner, a failure before tests start appears in the Actions log
but does not write a new report; upload steps warn when files are absent.
Reports, browser state and local credentials are ignored by Git. Reviewed replay
recordings in `.e2e/cache/` are committed, as recommended by the
[replay guide](https://e2e.tester.army/docs/cache). Dynamic email/workspace values
use `unique()` so replay substitutes a fresh identity. Passwords and OTPs are
opaque secret references, not literal values in recordings.

The runner uses its documented defaults: read-write cache locally; read-only
cache, one worker, one retry and traces on the first retry in CI. A serial retry
starts again at registration with a fresh account in installation mode. Each
agent step is bounded to 25 actions/model calls, with a five-minute test deadline.
A cache miss or stale recording falls back to the live agent; provider failures
fail the run. Use `pnpm test:e2e --no-cache` when you specifically need evidence
of fresh AI planning. Reports distinguish replay from model calls; an 8/8 pass
alone does not prove fresh AI was used.

A failed serial step skips its dependants. Selecting a member of a serial
group selects the entire group, so a filtered run is not an onboarding-only
pass. Check the report's passed/failed/skipped counts before calling the
journey successful. Missing GitHub/AI configuration must fail, not skip.

## Validation

The fresh AI journey passed twice before the CI-default alignment:
[runs 37143123234](https://github.com/mako-ai/mako/actions/runs/37143123234)
and [37143369841](https://github.com/mako-ai/mako/actions/runs/37143369841),
each with 8/8 tests, 10 agent goals and 42 Vercel AI Gateway model calls.
The PR records validation of the current CI configuration. An earlier preview
run exercised real emailed verification and GitHub OAuth before conversion to
agent navigation; it is not evidence of agent-driven OAuth.

## GitHub Actions

The workflow follows the [TesterArmy CI guide](https://e2e.tester.army/docs/ci):
automatic same-repository PR and default-branch (`master`) push runs, minimum
permissions, SHA-pinned Actions, frozen dependencies, separate browser setup,
runner-managed app startup, CI replay/retry/trace defaults, and seven-day reports
and browser diagnostics. Superseded PR runs are cancelled. Fork PRs are refused.

`.github/workflows/e2e-journey.yml` runs the Mako journey on an isolated runner
with local MongoDB and PostgreSQL, using the installation fixture above.
It reuses the existing `AI_GATEWAY_API_KEY` and `MAKO_GITHUB_APP_PRIVATE_KEY`
secrets and the App ID, slug and client ID repository variables. No additional
secret, personal session, PAT or automation user is required. App installation
access tokens are minted by Mako and expire; they are not persisted as CI secrets.

The job does not deploy Mako, push to the connected repository or access a shared
database. It uploads runner-redacted browser artifacts, including retry traces when
available. It never uploads browser state, `.e2e/sessions`, or unredacted app logs.

The default repository input is `mako-ai/test-workspace` (the existing Mako
test repository); it can be overridden at dispatch. CLI read access to that
repository alone does not prove the Mako App has access: the journey verifies
the real installation and repository picker.

Once the workflow is present on the default branch, launch **Mako E2E journey** in GitHub Actions, or:

```sh
gh workflow run e2e-journey.yml --repo mako-ai/mako --ref <trusted-branch>
```

To refresh recordings locally, run with the normal read-write cache, inspect the
changed `.e2e/cache/` files and commit them. After merge, `workflow_dispatch` also
accepts `record_cache=true`; download `mako-e2e-cache`, review its actions and
literal typed values, then commit the reviewed files. Normal CI only reads the
committed cache and never silently updates it. Reports and diagnostics upload
unless the run is cancelled, including when tests fail. Missing diagnostics are
reported as a warning (a first-attempt pass does not need a retry trace).

Test accounts/workspaces are retained for inspection; dispose of the dedicated
local test database between runs when appropriate. CI databases disappear
with the runner.
