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
| `run.mts` | The benchmark. Phases: `create`, `pause`, `snapshot`, `exec`, `chunk`, `parallel`, `metrics`. |
| `results/` | One JSON file per run. |

## Re-run

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
