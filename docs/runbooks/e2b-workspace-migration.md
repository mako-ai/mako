# Runbook: move Mako's E2B boxes to the "Mako" workspace

Mako's app sessions, publish box and connector boxes move from the personal
project "Rodriguezjoan's Project" to the company workspace "Mako". Production
moves to project `mako-prod`. Previews and laptops move to `mako-dev`. Aura
stays where it is.

Written 16 Nov 2026. The old project holds 89 paused `mako-apps` boxes and
about 15 running ones.

## What moves, and what does not

| Thing | Before | After |
| --- | --- | --- |
| Production app sessions, publish box, connector boxes | old project | `mako-prod` |
| PR previews and laptops | old project | `mako-dev` |
| `aura-sandbox` template and its boxes | old project | old project, untouched |
| Git history, branches, apps | Mako's git endpoint | unchanged |
| Mongo and Redis | no box ids stored | nothing to migrate |

Mako finds a box by its `makoAppsSessionKey` metadata in the account its key
opens. After the swap Mako cannot see the old boxes. It clones a fresh box
from the server branch on the next touch. Committed and pushed work is safe.
Work that lives only in an old box is copied to rescue refs in step 11, once
nobody uses those boxes any more.

## Rules for every command

- Never echo a key, never put one on a command line, never write one to a
  file. Read it into the environment with `$(gcloud secrets versions access ...)`.
- Run from a clean checkout of this repo on `master` with `pnpm install` done.
  It must hold no `.env.tunnel` (the pre-save script refuses to write while
  one exists).
- `api/src/apps/e2b-template.ts` reads the repo's root `.env` with
  `override: false`. An exported `E2B_API_KEY` wins. If the export comes back
  empty, the build fails with `E2B_API_KEY is required`, because an empty
  exported variable still counts as set.
- Check which account a key opens before using it (the account check below).

### Account check

Counts the boxes the key in `E2B_API_KEY` can see, by template and state. It
lists only.

```bash
pnpm --filter api exec node -e '
const { Sandbox } = require("e2b");
(async () => {
  const counts = {};
  const p = Sandbox.list({ limit: 100 });
  while (p.hasNext) for (const b of await p.nextItems()) {
    const k = `${b.name || b.templateId}/${b.state}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  console.log(JSON.stringify(counts));
})().catch(e => { console.error(e.message); process.exit(1); });'
```

The old key shows about 89 paused and 15 running `mako-apps` boxes plus the
Aura boxes. A new project key shows `{}` before step 4.

## Step 1. Upgrade `mako-prod` to Pro (Joan)

`mako-prod` is on Hobby with a 10-box cap. Production runs about 15 boxes at a
time, so the swap must not happen before this step.

Check: the E2B dashboard shows `mako-prod` on Pro with a concurrency cap of at
least 20.

## Step 2. Store the keys and record the old one (Joan)

1. Create secret `E2B_API_KEY` in `mako-ai-prod` with the `mako-prod` key.
2. Note the current version of `mako-ai-dev`'s `E2B_API_KEY`. That version is
   the OLD key. Steps 5, 11, 12 and rollback need it.
   ```bash
   gcloud secrets versions list E2B_API_KEY --project=mako-ai-dev
   export OLD_VERSION=<that version number>
   ```
3. Record the old key's hash. Step 12's kill refuses any other key.
   ```bash
   export OLD_KEY_SHA256="$(gcloud secrets versions access "$OLD_VERSION" --secret=E2B_API_KEY --project=mako-ai-dev | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)"
   echo "$OLD_KEY_SHA256"   # a hash, not the key; write it in the change log
   ```
4. Record the `mako-prod` key's hash too. Rollback step 3 drains `mako-prod`
   with the drain script, which refuses any key but the one this hash names.
   ```bash
   export PROD_KEY_SHA256="$(gcloud secrets versions access latest --secret=E2B_API_KEY --project=mako-ai-prod | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)"
   echo "$PROD_KEY_SHA256"   # a hash, not the key; write it in the change log
   ```
5. Add a new version of `mako-ai-dev`'s `E2B_API_KEY` with the `mako-dev` key.

Both hashes go in the change log as hashes only. Never write a key there.

Check: the old version is really the key production runs today. This must
print the same hash as `OLD_KEY_SHA256`.

```bash
gcloud run services describe mako --project=mako-ai-prod --region=europe-west1 --format=json \
  | jq -r '.spec.template.spec.containers[0].env[] | select(.name=="E2B_API_KEY") | .value' \
  | tr -d '\n' | shasum -a 256 | cut -d' ' -f1
```

Check: `gcloud secrets versions list E2B_API_KEY --project=mako-ai-prod` shows
1 enabled version.

## Step 3. Build the template in both new projects

Build in `mako-dev` first, then in `mako-prod`.

```bash
export E2B_API_KEY="$(gcloud secrets versions access latest --secret=E2B_API_KEY --project=mako-ai-dev)"
test -n "$E2B_API_KEY" && echo "key loaded"
# account check (above) must print {} for a fresh project
pnpm --filter api run apps:build-template
unset E2B_API_KEY

export E2B_API_KEY="$(gcloud secrets versions access latest --secret=E2B_API_KEY --project=mako-ai-prod)"
test -n "$E2B_API_KEY" && echo "key loaded"
pnpm --filter api run apps:build-template
unset E2B_API_KEY
```

Check: each build prints one JSON line with `"alias":"mako-apps"`, a
`templateId` and a `buildId`. The two `templateId`s differ from each other and
from the old project's.

If a build fails because the name `mako-apps` is taken, build that project
under another name and point Mako at it. No code change is needed. Production
and previews read separate variables, so production can never pick up the dev
name:

```bash
# mako-prod
E2B_TEMPLATE_ALIAS=mako-apps-prod pnpm --filter api run apps:build-template
gh variable set APPS_E2B_TEMPLATE_PROD --env production --body mako-apps-prod
# mako-dev
E2B_TEMPLATE_ALIAS=mako-apps-dev pnpm --filter api run apps:build-template
gh variable set APPS_E2B_TEMPLATE --body mako-apps-dev
```

For `mako-dev` also add a version of `APPS_E2B_TEMPLATE` in `mako-ai-dev`.

## Step 4. Smoke test each project: 1 box, then kill

Run once with the `mako-ai-dev` key and once with the `mako-ai-prod` key,
loaded as in step 3. Set `APPS_E2B_TEMPLATE` first if step 3 used another name.

```bash
pnpm --filter api exec node -e '
const { Sandbox } = require("e2b");
(async () => {
  const template = process.env.APPS_E2B_TEMPLATE || "mako-apps";
  const box = await Sandbox.create(template, { timeoutMs: 120000, metadata: { purpose: "e2b-move-smoke" } });
  try {
    const r = await box.commands.run("node -v && pnpm -v && git --version && test -d /home/user/app && echo app-dir-ok", { user: "user" });
    console.log(box.sandboxId, JSON.stringify(r.stdout.trim().split("\n")));
  } finally { await box.kill(); }
})().catch(e => { console.error(e.message); process.exit(1); });'
```

Check: the output lists `v24.22.1`, `10.33.3`, a git version and
`app-dir-ok`. The account check then prints `{}` again, so the box is gone.

## Step 5. Pre-save dry run on the old account

Read-only, so it is safe while users are active. It shows how much work only
the old boxes hold. Step 11 saves it after the swap.

```bash
export E2B_API_KEY="$(gcloud secrets versions access "$OLD_VERSION" --secret=E2B_API_KEY --project=mako-ai-dev)"
test -n "$E2B_API_KEY" && echo "key loaded"
pnpm --filter api exec tsx src/scripts/e2b-presave-sessions.ts | tee presave-dry.jsonl
unset E2B_API_KEY
```

The script resumes each paused `mako-apps` box for a few seconds, reads its
git status and pauses it again. Each line is one box:

- `would-save`: lists every changed path with its size and, when it would
  be left out, why (`secret-shaped name`, `excluded directory`, `over 10 MB`,
  `index-only`), plus unpushed branches,
  stashes and HEAD's unpushed commits (`headUnpushed`, an estimate here).
- `foreign-origin`: the box's origin is not `https://app.mako.ai/api/apps-git/<workspaceId>.git`.
  It is a preview or laptop box. Step 11 will not touch it.
- `clean`, or `skipped` for publish and connector boxes.

Check: the visited count is close to 89. `error` is 0. Read the excluded
paths. A file the user needs that is excluded (a 12 MB CSV, say) must be saved
by hand from that box before step 12.

## Step 6. Swap the GitHub secrets (Joan)

Since 17 Nov 2026 the deploys read `E2B_API_KEY` from Secret Manager
(`--set-secrets E2B_API_KEY=E2B_API_KEY:latest`), not from GitHub. Production
reads `mako-ai-prod`, previews read `mako-ai-dev`. A key change is now a new
Secret Manager version plus a redeploy. The GitHub secrets below are unused.

- Production environment secret `E2B_API_KEY` = `mako-prod` key.
- Repo-level secret `E2B_API_KEY` = `mako-dev` key. PR previews read this one.

Pipe from Secret Manager so no value is typed:

```bash
gcloud secrets versions access latest --secret=E2B_API_KEY --project=mako-ai-prod \
  | gh secret set E2B_API_KEY --env production
gcloud secrets versions access latest --secret=E2B_API_KEY --project=mako-ai-dev \
  | gh secret set E2B_API_KEY
```

Check: `gh secret list --env production` and `gh secret list` both show
`E2B_API_KEY` updated today.

Then move previews and laptops off the old account BEFORE the production
swap. Otherwise they keep starting boxes there, and step 10's gate and
step 12's kill cannot tell them from production boxes.

1. Redeploy every open PR preview. It picks up the repo secret, the
   `mako-dev` key:
   ```bash
   gh pr list --state open --json number -q '.[].number' \
     | xargs -I{} gh workflow run deploy-app.yml --ref master -f pr_number={} -f rebuild_db=false
   ```
2. Tell every developer in the team channel: run `pnpm secrets:pull` now, then
   restart `pnpm dev`.

Check: each preview's deploy run is green. With the old key loaded, the
step 5 dry run prints no `foreign-origin` box started after this point.

## Step 7. Deploy production

Cloud Run holds the key as a literal env var, so nothing changes until a
deploy. Record the revision that is live now, then deploy master:

```bash
export OLD_REVISION="$(gcloud run services describe mako --project=mako-ai-prod --region=europe-west1 --format='value(status.latestReadyRevisionName)')"
gh workflow run deploy-app.yml --ref master
gh run watch "$(gh run list --workflow deploy-app.yml --limit 1 --json databaseId -q '.[0].databaseId')"
export SWAP_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Approve the `production` environment if GitHub asks. `SWAP_TIME` is the
moment the new revision took traffic.

Check: the run is green. The new revision name differs from `OLD_REVISION`.
The step 2 hash command now prints the hash of `mako-ai-prod`'s key, not
`OLD_KEY_SHA256`.

### Canary

`deploy-prod-canary.yml` sets no `E2B_API_KEY` and no `APPS_SANDBOX_PROVIDER`,
so `mako-canary` runs no sandboxes today and the swap does not touch it.
Redeploy it only if you want it on the same image:

```bash
gh workflow run deploy-prod-canary.yml --ref master -f confirm=mako-ai-prod
```

Check: the step 2 describe-and-jq command against `mako-canary` prints no
`E2B_API_KEY` value.

## Step 8. Verify the swap

1. Open an app in app.mako.ai and start its preview.
2. Load the `mako-ai-prod` key and run the account check.
   Check: at least 1 running `mako-apps` box exists in `mako-prod`.
3. Run the connector sync and a publish once.
   Check: both succeed. Their first run in the new project is slower, because
   the box installs its runtime.

## Step 9. What happens to sessions mid-flight

- **Requests already running** finish on `OLD_REVISION` with the old key. An
  agent turn there ends with its normal commit and push.
- **New requests** reach the new revision. The user's next touch clones a
  fresh box from their branch. Their branch choice survives, because it lives
  in Mongo (`AppWorktree.branch`).
- **Open terminals** close when the old instance drains. Reconnecting opens a
  shell in the new box. Shell history and running processes in the old box
  are not carried over.
- **Dev-server previews** restart in the new box. A running old box keeps
  reporting for up to 10 idle minutes. The API drops those reports once the
  new account holds a box for that session (`box-state.service.ts`), so the
  preview URL does not flap between the two machines.
- **Uncommitted work in old boxes** waits there until step 11 copies it to
  rescue refs.
- **Publish and connector boxes** are rebuilt on first use. They hold no
  user work.
- **Laptops and open PR previews** moved to `mako-dev` at step 6, before
  this swap. A laptop that missed the re-pull, or a preview that missed the
  redeploy, still starts boxes in the old account. Step 10's gate stops on
  such a box, because step 5's dry run did not name it. Re-pull or redeploy
  it, then run the gate again.

## Step 10. Wait for the old revision to drain

Step 11 must not race a live user, so all 3 gates must hold:

1. At least 60 minutes since `SWAP_TIME`. Cloud Run's request timeout is
   3600 seconds, so no request on `OLD_REVISION` can still be running.
2. 0 instances of `OLD_REVISION`. The access token goes through stdin, not
   the command line. The block prints `GATE FAILED` on any API error, so a
   failed call never reads as 0:
   ```bash
   (
     set -euo pipefail
     start="$(node -e 'console.log(new Date(Date.now() - 5 * 60e3).toISOString())')"
     end="$(node -e 'console.log(new Date().toISOString())')"
     gcloud auth print-access-token | sed 's/^/Authorization: Bearer /' \
       | curl -fsS -H @- -G "https://monitoring.googleapis.com/v3/projects/mako-ai-prod/timeSeries" \
         --data-urlencode "filter=metric.type=\"run.googleapis.com/container/instance_count\" AND resource.labels.service_name=\"mako\" AND resource.labels.revision_name=\"$OLD_REVISION\"" \
         --data-urlencode "interval.startTime=$start" \
         --data-urlencode "interval.endTime=$end" \
       | jq -e 'if has("error") then error(.error.message) else [.timeSeries[]?.points[0].value.int64Value // "0" | tonumber] | add // 0 end'
   ) || echo "GATE FAILED"
   ```
   Check: `0`. An empty result (`0`) is what Cloud Monitoring returns once the
   revision has had no instances for the whole window.
3. 0 Mako boxes started in the old account since the swap. The drain script's
   dry run checks this, and also that the key is the old one:
   ```bash
   export E2B_API_KEY="$(gcloud secrets versions access "$OLD_VERSION" --secret=E2B_API_KEY --project=mako-ai-dev)"
   pnpm --filter api exec tsx src/scripts/e2b-drain-old-boxes.ts \
     --expect-key-sha256 "$OLD_KEY_SHA256" --swap-time "$SWAP_TIME" \
     --ignore-foreign-from presave-dry.jsonl
   ```
   Check: exit code 0 and `"startedAfterSwap":[]`. `--ignore-foreign-from`
   leaves out the boxes step 5 classed `foreign-origin`, by sandbox id (preview and laptop
   boxes), which are not production's to gate on or kill.

## Step 11. Pre-save apply on every old box

Now nobody uses the old boxes, running or paused, so copying their work
disturbs no one.

`--apply` needs production's git-token secret and database, read from the
running `mako` service into the environment. It also needs the production
origin, exported explicitly. It refuses any other value, and it refuses to
run while a `.env.tunnel` exists.

```bash
svc_env() { gcloud run services describe mako --project=mako-ai-prod --region=europe-west1 --format=json \
  | jq -r --arg n "$1" '.spec.template.spec.containers[0].env[] | select(.name==$n) | .value'; }
export SESSION_SECRET="$(svc_env SESSION_SECRET)"
export DATABASE_URL="$(svc_env DATABASE_URL)"
export APPS_GIT_ORIGIN_URL=https://app.mako.ai
# E2B_API_KEY still holds the OLD key from step 10
test -n "$SESSION_SECRET" && test -n "$DATABASE_URL" && echo "env loaded"
pnpm --filter api exec tsx src/scripts/e2b-presave-sessions.ts --include-running | tee presave-final-dry.jsonl
pnpm --filter api exec tsx src/scripts/e2b-presave-sessions.ts --include-running --apply | tee presave-apply.jsonl
unset SESSION_SECRET DATABASE_URL E2B_API_KEY
```

What `--apply` does on each box whose origin is this workspace's production
endpoint. Every rule lives in `api/src/apps/box/rescue-commit.ts`, the helper
the idle-box reaper uses too:

1. It mints a fresh git token. Paused boxes hold an expired one. The origin
   URL is rewritten to the same value.
2. It fetches the server's branches into `refs/mako-server/*`. Only that
   fresh read counts as "on the server"; local tracking refs never do.
3. Each other local branch with commits the server lacks goes to
   `mako-presave/<userId>/<date>-branch/<name>`, and each stash to
   `<date>-stash-<sha7>`, named by the stash commit.
4. The working tree's changes, built in a throwaway index on top of HEAD,
   go to `mako-presave/<userId>/<YYYY-MM-DD>`. HEAD's own unpushed commits,
   on a branch or a detached HEAD, travel with it as ancestors. HEAD, the
   index, the working tree and every branch stay as they were.
5. If that name is taken by different content, the push goes to
   `<date>-<sha8>`. If the server already holds the same rescue (same tree on
   the same parent), nothing is pushed and the row says `"worktree":"unchanged"`.
6. It never pushes to main or the session branch, never forces, and never
   pulls or merges. A failed push is reported, not repaired.

It leaves out files over 10 MB, anything under `node_modules/`, `target/` or
`dist/` (any letter case), and secret-shaped names in any letter case: the
list is `RESCUE_SECRET_NAMES` in `rescue-commit.ts` (`.env*`, `*.pem`,
`*.key`, `id_*`, `.npmrc`, `credentials*.json`, `*secret*.json`, GCP key file
names and more), plus `.aws/credentials`.

A push uploads every commit the server lacks, not just the tip. So before
each push, every blob added by a commit outside `refs/mako-server/*` is
scanned with the same rules. One hit and that ref is not pushed. The
worktree rescue also refuses to build on a HEAD whose tree holds such a file.

A row is `manual` when anything was blocked, any push failed, a merge or
rebase is in progress, or any file outside `node_modules/`, `target/` or
`dist/` was left out (a file only the index held counts). A left-out file is
work that did not reach the server.

The refs are siblings of `<date>`, not children, because git cannot hold a
branch and a folder of branches under one name.

Check: `saved` plus `clean` covers every visited box. `error` is 0. Each
`manual` row is resolved by hand in its box or accepted. Every pushed ref
shows in that workspace's Source Control branch list on app.mako.ai.

Users find their work on `mako-presave/<userId>/<date>` and merge or
cherry-pick what they want.

## Rollback

Rollback works for the 7 days of the drain, while the old boxes still exist.

1. Put the old key back as the latest version of `mako-ai-prod`'s secret.
   The deploy reads `E2B_API_KEY:latest` from there:
   ```bash
   gcloud secrets versions access "$OLD_VERSION" --secret=E2B_API_KEY --project=mako-ai-dev \
     | gcloud secrets versions add E2B_API_KEY --project=mako-ai-prod --data-file=-
   ```
2. Redeploy as in step 7. Record `OLD_REVISION` and `SWAP_TIME` again. If
   step 3 used another name, also run
   `gh variable delete APPS_E2B_TEMPLATE_PROD --env production`.
3. Wait for the drain as in step 10. Gate 3 uses the drain script with the
   `mako-ai-prod` key and `--expect-key-sha256 "$PROD_KEY_SHA256"` (recorded
   in step 2), because `mako-prod` is now the account being left.
4. Save what only the `mako-prod` boxes hold. Run step 11 with the
   `mako-ai-prod` key.

Check: the step 2 hash command prints `OLD_KEY_SHA256` again. New sessions
show up in the old project. Old paused boxes resume where they were, because
their session keys still match.

## Step 12. Drain the old boxes for 7 days

Keep the old project's `mako-apps` boxes for 7 days after the swap. A user who
finds work missing can be helped from their old box in that window: run
step 11 with `--only <workspaceId>:<userId>`.

Check once a day: the step 10 drain dry run exits 0 with
`"startedAfterSwap":[]`.

On day 7:

1. Re-run step 11's `--apply` with the same environment. It is idempotent: a
   rescue the server already holds is reported, not pushed again.
   ```bash
   pnpm --filter api exec tsx src/scripts/e2b-presave-sessions.ts --include-running --apply | tee presave-recheck.jsonl
   jq -c 'select(.changed == true)' presave-recheck.jsonl
   ```
   Check: the `jq` line prints nothing. Every saved row shows
   `"worktree":"unchanged"` (or no `worktree` key) and every ref
   `"status":"unchanged"`. A branch already rescued is no longer box-only
   work, so it does not appear at all. A row with `changed: true` means work appeared
   after step 11; tell that user it is on their rescue branch.
2. Kill the old Mako boxes with the drain script. It aborts, killing nothing,
   unless the key's sha256 equals `OLD_KEY_SHA256` and no Mako box in that
   account started after `SWAP_TIME`. It only touches `mako-apps` boxes that
   carry `makoAppsSessionKey`, so Aura's boxes are never candidates. Boxes
   the final dry run classed `foreign-origin` are skipped too, by sandbox id,
   and listed in the report's `ignoredIds`.
   ```bash
   export E2B_API_KEY="$(gcloud secrets versions access "$OLD_VERSION" --secret=E2B_API_KEY --project=mako-ai-dev)"
   pnpm --filter api exec tsx src/scripts/e2b-drain-old-boxes.ts \
     --expect-key-sha256 "$OLD_KEY_SHA256" --swap-time "$SWAP_TIME" \
     --ignore-foreign-from presave-final-dry.jsonl          # dry run: read the candidates
   pnpm --filter api exec tsx src/scripts/e2b-drain-old-boxes.ts \
     --expect-key-sha256 "$OLD_KEY_SHA256" --swap-time "$SWAP_TIME" \
     --ignore-foreign-from presave-final-dry.jsonl --apply
   unset E2B_API_KEY
   ```
   Check: `killed` equals the dry run's `candidates`, and `failed` is empty.
   Keep the `--apply` output: its `ignoredIds` are the expected leftovers.
3. Run the account check. Check: the only `mako-apps` boxes left are the
   `ignoredIds` from item 2, and nothing else but `aura-sandbox` boxes. Those
   leftovers are preview and laptop boxes whose work belongs to staging or a
   laptop, not production.
4. Delete the `mako-apps` template from the old project only when the account
   check shows 0 `mako-apps` boxes. A box needs its template to resume, so
   while any leftover exists the template stays. For each leftover, tell its
   owner (a developer for a laptop box, the PR author for a preview) to push
   what they need. When they confirm, or after 7 more days, kill the
   leftovers with the same drain command without `--ignore-foreign-from`,
   run the account check again, and then delete the template.
5. Disable `OLD_VERSION` of `mako-ai-dev`'s `E2B_API_KEY`. That ends rollback.

## Aura stays untouched

- The `aura-sandbox` template and its boxes stay in the old project.
- Every Mako command here filters on template `mako-apps` and the
  `makoAppsSessionKey` metadata, which Aura's boxes do not carry.
- Do not revoke the old project's API key or delete the old project. Aura may
  use that key.

## Code that makes the move safe

- `api/src/apps/sandbox/e2b-provider.ts`: an unknown or old-account box id
  leads to a fresh box. Pinned-only mode lets a script visit one exact box
  with no list, create or kill. `sessionSandboxIds` lists a session's boxes.
- `api/src/apps/box-state.service.ts`: drops reports from a box the provider
  does not hold once it holds another one for that session.
- `api/src/apps/box/rescue-commit.ts`: the rescue rules and the worktree
  rescue, shared with the idle-box reaper.
- `api/src/apps/box-presave.ts` and `api/src/scripts/e2b-presave-sessions.ts`:
  the pre-save pass.
- `api/src/apps/box-drain.ts` and `api/src/scripts/e2b-drain-old-boxes.ts`:
  the guarded kill.
- `.github/workflows/deploy-app.yml`: previews read `vars.APPS_E2B_TEMPLATE`,
  production reads `vars.APPS_E2B_TEMPLATE_PROD`, both defaulting to
  `mako-apps`.
