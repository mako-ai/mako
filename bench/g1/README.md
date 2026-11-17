# G1: E2B box overhead for connector chunks

Gate G1 of [`rfcs/connector-runtime.md`](../../rfcs/connector-runtime.md) §10.
It measures what a connector chunk costs in an E2B box, through the code that
runs workspace connectors today: `getSandboxProvider()`, `sync-box.ts`
(`materializeConnector`, `runConnectorCommand`) and
`SandboxedConnector.fetchEntityChunk`. No product code changes.

Results: [`RESULTS.md`](./RESULTS.md). Raw numbers: `results/*.json`.

## What is here

| Path | What it is |
| --- | --- |
| `connector/` | A connector folder on `@makoai/connector-sdk`. Three entities (`email`, `call`, `fixed-1k`) page through a synthetic Close-shaped activity feed generated inside the box. 100-row pages. Record sizes follow RealAdvisor's ES Close tables (email mean 32.4 KB, call mean 9.5 KB). No network. |
| `run-v2.mts` | The benchmark for the current chunk path (master 3608123c1 and later): flag off and flag on (`CONNECTOR_BOX_LEASES`), warm and cold chunks, in-box boot timing, parallel throughput. |
| `run.mts` | The first benchmark, for the chunk path before 3608123c1 (8 provider calls per chunk). It imports `sync-box.ts` internals that 3608123c1 changed, so run it from a checkout of 21a1d5172. Its raw-SDK phases (`create`, `pause`, `snapshot`, `exec`) do not depend on Mako code. |
| `results/` | One JSON file per run. |

## Re-run the current path (`run-v2.mts`)

Use the `mako-dev` E2B project: Pro plan, 100 boxes, no users. Its key is
`E2B_API_KEY` version 2 in Secret Manager project `mako-ai-dev`. Load it into
the process environment only:

```bash
cd api
E2B_API_KEY="$(gcloud secrets versions access 2 --secret E2B_API_KEY --project mako-ai-dev)" \
APPS_E2B_TEMPLATE=mako-apps pnpm exec tsx ../bench/g1/run-v2.mts
```

Options: `--phases` (default `off-warm,boot,off-cold,on-warm,on-cold,parallel`),
`--chunks` per entity and per box (30), `--n` samples per cold path (10),
`--account-cap` running boxes allowed on the account (10), `--out`.

A full run takes about 17 minutes. It holds at most 9 boxes at once (8 in
`parallel`, plus the warm sync box), creates about 27 boxes and 13 snapshots,
and kills or deletes all of them in a `finally`, on Ctrl-C and on SIGTERM. It
touches only boxes it made. The results file's `cleanup` records what it
killed and what was left (0 so far).

Flag on runs the real `BoxScheduler` with its Mongo store replaced by
`MemoryBoxStore`, so no database is needed. The scheduler's account ceiling is
set to `--account-cap`.

To measure from europe-west1, where the API runs, copy the checkout to a GCE VM
there and pass the key over ssh stdin, never as an argument or a file:

```bash
gcloud secrets versions access 2 --secret E2B_API_KEY --project mako-ai-dev | \
  gcloud compute ssh <vm> --command 'IFS= read -r E2B_API_KEY; export E2B_API_KEY; cd ~/mako/api && APPS_E2B_TEMPLATE=mako-apps ./node_modules/.bin/tsx ../bench/g1/run-v2.mts'
```

To measure E2B's EU region, use the `mako-eu` project. Its key is
`E2B_API_KEY_EU` in Secret Manager project `mako-ai-dev`. EU projects answer
only on their own domain, so set `E2B_DOMAIN=e2b-juliett.dev` with the key.
On a VM, give its service account `secretAccessor` on that one secret and read
the key there:

```bash
export E2B_API_KEY="$(gcloud secrets versions access latest --secret=E2B_API_KEY_EU --project=mako-ai-dev)"
E2B_DOMAIN=e2b-juliett.dev APPS_E2B_TEMPLATE=mako-apps ./node_modules/.bin/tsx ../bench/g1/run-v2.mts
```

## Re-run the first benchmark (`run.mts`)

**Use an E2B team that serves no app sessions.** The local-development key
reaches the team that runs live app sessions. On 16 Nov 2026 that team capped
concurrent sandboxes at 20, and apps held 17–19 of them. Every box this script
starts takes a slot an app preview may need. The script counts running
sandboxes first and refuses to start with fewer than 6 free slots (10 with
`parallel`). It counts again before every box it creates, and stops the phase
when a new box would leave fewer than 3 free slots (`--floor`). Override
`--account-cap`, `--min-free` and `--floor` only on a team of your own.

You need Node 24, `pnpm install` at the repo root, and an `E2B_API_KEY` for
local development (`pnpm secrets:pull` writes it into `.env`). The script reads
only `E2B_API_KEY` and `APPS_E2B_TEMPLATE` from the env file and prints neither.

```bash
cd api
pnpm exec tsx ../bench/g1/run.mts --env-file ../.env
# a subset, fewer samples:
pnpm exec tsx ../bench/g1/run.mts --env-file ../.env --phases exec,chunk --n 5 --chunks 5
```

Options: `--phases` (comma list), `--n` samples per latency phase (default 20),
`--chunks` chunks per entity and per box (default 30), `--out` results path.

A full run takes about 30 minutes and creates about 60 short-lived boxes. It
holds at most 2 boxes at once, or 5 during `parallel`.
Every box carries the run's tag (`benchG1` metadata, or a
`connector-sync:g1-…` session key). The script kills every box it made in a
`finally`, and also on Ctrl-C or SIGTERM. It then sweeps the account for
anything left with its tag and deletes the snapshot it took. The results file
records `boxes.created`, `boxes.killed` and `boxes.leftRunning`. A box counts as
killed only when E2B confirms it.

## What each phase measures

| Phase | Measures |
| --- | --- |
| `create` | `Sandbox.create(template)` to the first command, from the apps template the sync box uses |
| `pause` | `Sandbox.pause` (memory kept), then `Sandbox.connect` (resume) to the first command |
| `snapshot` | `createSnapshot` of a box with the connector runtime installed, then `Sandbox.create(snapshotId)` to the first command and to a 1-page read; then `fork()` |
| `exec` | A no-op through `provider.exec` (what `sync-box.ts` pays per call), a raw `commands.run`, a bare `Sandbox.connect` and a small file write |
| `chunk` | One 10-page chunk (1,000 rows) through `SandboxedConnector.fetchEntityChunk` in a warm box, against the same chunk in-process and through the local provider (a subprocess on this machine). Each provider round trip is timed. |
| `lean` | The same chunk in 2 or 3 round trips on a held `Sandbox` handle: what a lease-shaped `sync-box.ts` would cost |
| `parallel` | Rows per second with 1, 2 and 4 warm boxes running chunks at once |
| `metrics` | Peak RSS and CPU time of one chunk's process (Node `resourceUsage`), and E2B's sampled CPU and memory during 20 email chunks |

The in-process baseline is the connector's generator iterated in the API
process: no subprocess, no serialisation. It is what Close costs today minus
the vendor.
