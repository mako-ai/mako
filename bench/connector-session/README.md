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

When the connector is behind, a pull costs 4 calls: the optimistic
`readFile` misses, then a `wait`, then the read and the acknowledgement.

### What this means on E2B

The Docker box understates the saving. One E2B round trip costs 176 ms from
Europe against 29 ms here (bench G1), and the live test of the boxed path
measured a warm chunk at 3.2–4.1 s, mostly the process start. A session
batch that is ready costs one `readFile` on the critical path. G1 measured
that read at 416 ms p50 for a 9.6 MB `call` chunk. This model, not a
measurement, puts a warm session batch near 0.4 s against 3.2–4.1 s. The
E2B number needs a live run (the G1 script's E2B account rules apply).

Nothing was left in the box after the 16 reads: no run user, no run
directory, no session directory.
