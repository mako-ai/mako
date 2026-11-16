# Read sessions: per-batch latency, chunk processes against one process per read

Measures what `CONNECTOR_SESSION_READS` saves per batch. Both modes run
through the API's own code: `SandboxedConnector.fetchEntityChunk`,
`sync-box.ts` (runtime install, per-run Unix users, chunk runs) and
`session-read.ts`. The box is a local Docker container from E2B's
`e2bdev/base` image, capped at 2 vCPU and 2 GiB, reached through
`docker exec` with real Unix users. The connector is bench G1's synthetic,
Close-shaped feed (`../g1/connector`), generated in the box. No E2B account.

```bash
cd api
pnpm exec tsx ../bench/connector-session/run.mts
# fewer scenarios:
pnpm exec tsx ../bench/connector-session/run.mts --chunks 10 --entities call --page-delays 0 --write-delays 0
```

Options: `--chunks` (default 20), `--entities` (`call,email`), `--page-delays`
(ms per page, a vendor's latency; `0,200`), `--write-delays` (ms the API
spends writing each batch; `0,500`), `--out`.

Per-batch latency is `fetchEntityChunk`'s own time with the write excluded,
for batches 2 to 20. Batch 1 is reported apart: it starts the process in
both modes.

## Results, 16 Nov 2026

Raw: [`results/2026-11-16.json`](./results/2026-11-16.json). Apple M5 Pro
host, Docker 29.8, connector Node 24.22.1. One `docker exec` round trip:
29 ms p50, 35 ms p95.

### Pure overhead: a source with no latency

| Entity | Batch | Chunk process p50 | Session p50 | Chunk p95 | Session p95 | Calls per batch |
| --- | --- | --- | --- | --- | --- | --- |
| `call`, 1,000 rows, 9.6 MB | 2–20 | 223 ms | 49 ms | 247 ms | 63 ms | 4 → 2 |
| `email`, 570 rows, about 16 MB | 2–20 | 239 ms | 79 ms | 319 ms | 114 ms | 4 → 2 |
| `call` | 1 | 267 ms | 242 ms | – | – | 5 → 3 |

A session batch costs 78% less for `call` (174 ms saved) and 67% less for
`email` (160 ms saved). The saving is the process start (Node boot, SDK
import, connector load), the per-run user's setup and cleanup, and 2 calls.
Of the 2 calls left, 1 is the acknowledgement, which runs beside the read.

### Where the time goes, per batch (`call`, no latency, p50)

From the second run, which traced every provider call. Chunk process 226 ms, session 52 ms.

| Step | Chunk process | Session |
| --- | --- | --- |
| Write the inputs (config, catalog, state) | 35 ms | 0, once per read |
| Command round trip | 32 ms | 0 |
| Per-run user setup, in the box | 26 ms | 0, once per read |
| Connector process start (Node, SDK, connector), in the box | 37 ms | 0, once per read |
| Reading 10 pages and cutting the output | about 22 ms | in the background |
| Per-run user cleanup, in the box | 25 ms | 0, once per read |
| Read the output back (9.6 MB) | 43 ms | 45 ms |
| Acknowledge or remove the output | off the path | off the path |

The process start is 37 of the 174 ms saved (21%). The rest is transport and isolation: the input write (35 ms), the command round trip (32 ms) and the per-run user's setup and cleanup (51 ms). Only the read-back remains.

### With a vendor's latency (200 ms per page) and a warehouse write (500 ms)

| Entity | Write | Chunk process p50 | Session p50 | Saved |
| --- | --- | --- | --- | --- |
| `call` | 0 ms | 2,343 ms | 2,047 ms | 296 ms (13%) |
| `call` | 500 ms | 2,305 ms | 1,564 ms | 741 ms (32%) |
| `email` | 0 ms | 1,479 ms | 1,248 ms | 231 ms (16%) |
| `email` | 500 ms | 1,491 ms | 991 ms | 500 ms (34%) |

With a write, the session overlaps it with the next read: the connector
keeps paging while the API writes, held back at 2 batches. Twenty `call`
batches took 42.0 s in a session against 56.2 s as chunk processes (25%
less wall time).

A noisy host moved one chunk-process number between runs: `call` with 200 ms pages and a 500 ms write took 2,305 ms in the first run and 3,003 ms in the second. The session took 1,564 and 1,543 ms.

When the connector is behind, a pull costs 4 calls: the optimistic
`readFile` misses, then a `wait`, then the read and the acknowledgement.

### What this means on E2B

The G1 re-run measured a warm flag-off chunk from `europe-west1` at 917 ms:
- input write 164 ms;
- command round trip 165 ms;
- per-run user isolation 131 ms;
- connector start 100 ms;
- read-back of 9.6 MB 271 ms.

A ready session batch keeps the read-back (271 ms) and the 86 ms G1 did not attribute. This model, not a measurement, puts it near 357 ms against 917 ms, or 560 ms (61%) saved per batch. The process start is 100 ms of that. The input write, the command round trip and the user isolation are 460 ms, which a session pays once per read.

With `CONNECTOR_BOX_LEASES` on, each chunk adds 3 round trips of 519 ms (ping, runtime check, connector check). Sessions do not run with leases on yet, so they do not remove those.

The E2B number needs a live run (the G1 script's E2B account rules apply).

Nothing was left in the box after the 16 reads: no run user, no run
directory, no session directory.

## A session across an E2B pause, 16 Nov 2026

`e2b-pause.mts` runs the session scripts in a real E2B box (template
`mako-apps`, dev `3f2t2qgqsu5m8e42xd5i`, project `mako-dev`), sent hidden
from argv as the API sends them. The connector is a shell loop run as the
per-run user. Every box it makes is killed at the end.

```bash
cd api
E2B_API_KEY=... pnpm exec tsx ../bench/connector-session/e2b-pause.mts
```

Raw: [`results/e2b-pause-2026-11-16.json`](./results/e2b-pause-2026-11-16.json). 30 of 30 checks passed.

| Pause | Pause call | Resume to first command | Box clock | Boot |
| --- | --- | --- | --- | --- |
| Full (memory), 20 s | 897 ms | 1,231 ms | jumped 23 s | same |
| Filesystem only, 20 s | 399 ms | 9,588 ms | – | new |

- Full pause: session A (10-minute idle limit) served batches 3 to 6 after the resume, ended `done` and left nothing. Its wrapper was the same process, same start time.
- Full pause: session B (10-second idle limit) ended itself on resume, because the box clock jumped 23 s. It was gone 179 ms after the resume, user and run directory included. The API reads that as `lost` and restarts from the last applied state.
- Filesystem pause: the box booted again. Session C's run user and run directory were still on disk. Its record was pointed at a live bystander with the bystander's real start time and the old boot id, as a reused pid would look. The next start reaped C and the bystander lived.
- `/proc` was mounted `hidepid=invisible` after every start. A reboot drops it until the next start.
