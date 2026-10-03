# Mako user journey · TesterArmy e2e

Uses [TesterArmy e2e](https://tester.army/e2e), its Playwright engine and the
official skill at `.agents/skills/e2e/SKILL.md`. Node >=22.12 is required.
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
for the runner; configure Mako's API separately in the root `.env` using the
normal development instructions in `CLAUDE.md`.

| Variable                              | Purpose                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `MAKO_E2E_BASE_URL`                   | Running Mako URL; defaults to `http://localhost:5173`.                                                                   |
| `AI_GATEWAY_API_KEY`                  | Vercel AI Gateway authentication for the browser agent; required locally even when testing a preview.                    |
| `MAKO_E2E_MODEL`                      | Agent model; defaults to `openai/gpt-6-luna-fast`.                                                                       |
| `MAKO_E2E_MONGODB_URI`                | Isolated loopback MongoDB replica set named **mako_e2e**: reads the email code; CI also writes the installation fixture. |
| `MAKO_E2E_EMAIL`, `MAKO_E2E_PASSWORD` | Optional fresh test identity; otherwise randomly generated. Keep SendGrid disabled locally.                              |
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
All reports, browser state and local credentials are ignored by Git.
Replay caching is disabled, so each run exercises the live browser agent.
Each agent step is bounded to 25 actions/model calls, with a five-minute test
deadline and no retries. The report records agent steps and model usage; an
8/8 pass alone does not establish that AI was used. Provider failures fail the
run, with no fallback to a deterministic journey.

A failed serial step skips its dependants. Selecting a member of a serial
group selects the entire group, so a filtered run is not an onboarding-only
pass. Check the report's passed/failed/skipped counts before calling the
journey successful. Missing GitHub/AI configuration must fail, not skip.

## Validation

Before conversion to agent-driven navigation, all eight checks passed on
2026-10-03 against PR #1031's preview with a fresh
account, a real emailed verification code, GitHub OAuth and
`mako-ai/test-workspace`, a real assistant response and SQL result `42`.
The hosted installation-fixture run also passed **8/8, no skips or flaky tests**
on [GitHub Actions](https://github.com/mako-ai/mako/actions/runs/37139829098).
The repository's API suites also passed: 339 dbt/integration tests and 519 apps
tests (two pre-existing gated dbt tests skipped). TypeScript, formatting and
workflow syntax checks passed. These earlier results validate the deterministic
journey, not the new browser agent. No production deployment was performed.

## Manual GitHub Actions run

`.github/workflows/e2e-journey.yml` runs the Mako journey on an isolated runner
with local MongoDB and PostgreSQL, using the installation fixture above.
It reuses the existing `AI_GATEWAY_API_KEY` and `MAKO_GITHUB_APP_PRIVATE_KEY`
secrets and the App ID, slug and client ID repository variables. No additional
secret, personal session, PAT or automation user is required. App installation
access tokens are minted by Mako and expire; they are not persisted as CI secrets.

The job does not deploy Mako, push to the connected repository or access a shared
database. It never uploads browser state, OAuth traces or API logs.

The default repository input is `mako-ai/test-workspace` (the existing Mako
test repository); it can be overridden at dispatch. CLI read access to that
repository alone does not prove the Mako App has access: the journey verifies
the real installation and repository picker.

Once the workflow is present on the default branch, launch **Mako E2E journey** in GitHub Actions, or:

```sh
gh workflow run e2e-journey.yml --repo mako-ai/mako --ref <trusted-branch>
```

Before merging the workflow, a repository collaborator can explicitly run it
by adding the `run-e2e` label to a same-repository PR. Remove and re-add the
label for another run. Fork PRs are refused. An existing label does not rerun
tests on subsequent pushes; label again to test the new commit.

It is manual-only; no schedule or automatic push trigger is enabled. The job
uploads only the test JSON and JUnit reports, with seven-day retention.

Test accounts/workspaces are retained for inspection; dispose of the dedicated
local test database between runs when appropriate. CI databases disappear
with the runner.
