# Mako user journey · TesterArmy e2e

Uses [TesterArmy e2e](https://tester.army/e2e), its Playwright engine and the
official skill at `.agents/skills/e2e/SKILL.md`. Node >=22.12 is required.

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

| Variable                              | Purpose                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `MAKO_E2E_BASE_URL`                   | Running Mako URL; defaults to `http://localhost:5173`.                                                                              |
| `MAKO_E2E_MONGODB_URI`                | For automatic email-code lookup: the API's isolated, loopback MongoDB replica set, database **mako_e2e**. Only a read is performed. |
| `MAKO_E2E_EMAIL`, `MAKO_E2E_PASSWORD` | Optional fresh test identity; otherwise randomly generated. Keep SendGrid disabled locally.                                         |
| `MAKO_E2E_GITHUB_STATE`               | Path to a Playwright storage-state JSON from a dedicated GitHub test account. Only github.com cookies are restored.                 |
| `MAKO_E2E_GITHUB_REPO`                | Exact `owner/repo` of an existing disposable test repository accessible to the Mako GitHub App.                                     |
| `MAKO_E2E_VERIFICATION_FILE`          | For previews: ignored JSON file containing the fresh identity and its real emailed code.                                            |

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

Browser actions use deterministic selectors and do not need an AI key. The
Mako API itself needs `AI_GATEWAY_API_KEY` for the real chat assertion. The
preview run creates only its fresh test user/workspace and uses read-only SQL.

## GitHub session

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

A failed serial step skips its dependants. Selecting a member of a serial
group selects the entire group, so a filtered run is not an onboarding-only
pass. Check the report's passed/failed/skipped counts before calling the
journey successful. Missing GitHub/AI configuration must fail, not skip.

## Manual GitHub Actions run

`.github/workflows/e2e-journey.yml` runs the same complete journey on an
isolated runner with local MongoDB and PostgreSQL. It uses the repository's
existing `AI_GATEWAY_API_KEY`, `MAKO_GITHUB_APP_PRIVATE_KEY` and
`MAKO_GITHUB_APP_CLIENT_SECRET` secrets, plus the matching App ID, slug and
client ID repository variables. It does not read secrets back through `gh`,
deploy Mako, push to the connected repository, or access a shared database.

One additional secret is required: `MAKO_E2E_GITHUB_STATE_JSON`, containing
the storage-state JSON of a **dedicated test identity** already authorized for
the Mako App. Do not upload a personal browser session. The workflow filters
the state to github.com cookies and never uploads it, OAuth traces or API logs.
Expired or missing state fails the run; it is not a skipped passing check.

The default repository input is `mako-ai/test-workspace` (the existing Mako
test repository); it can be overridden at dispatch. CLI read access to that
repository alone does not prove the Mako App has access: the journey verifies
the real installation and repository picker.

Once the workflow is present on the default branch and the test session is
configured, launch **Mako E2E journey** in GitHub Actions, or:

```sh
gh workflow run e2e-journey.yml --repo mako-ai/mako --ref <trusted-branch>
```

It is manual-only; no schedule or automatic PR trigger is enabled. The job
uploads only the test JSON and JUnit reports, with seven-day retention.

Test accounts/workspaces are retained for inspection; dispose of the dedicated
local test database between runs when appropriate. CI databases disappear
with the runner.
