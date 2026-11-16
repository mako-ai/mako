# G1 results: E2B box overhead for connector chunks

Run `g1-mwjd1w9b`, 16 Nov 2026, 14:30–14:41 UTC. Raw numbers: [`results/2026-11-16.json`](./results/2026-11-16.json).

## Top finding: connector boxes share a 20-sandbox cap with live app sessions

- The E2B team behind the local-development key caps concurrent sandboxes at 20. E2B's API said so when the benchmark asked for a third box: "you have reached the maximum number of concurrent E2B sandboxes (20)".
- That team runs real users' app sessions. At 14:32 UTC it held 17 running sandboxes besides this benchmark: 14 app sessions on `mako-apps`, 2 on `aura-sandbox` and 1 connector sync box. Minutes after the run stopped it held 19.
- Two connector boxes would have filled it. A Close backfill on 2–4 boxes (RFC §6.3) would refuse new app previews with "Rate limit exceeded".
- The benchmark stopped at that point. It started no more boxes. Parallel throughput is **not measured: shared 20-sandbox cap**. The `lean` and `metrics` phases did not run either.
- The documented tiers are 10 concurrent sandboxes on Hobby and 100–1,100 on Pro (docs.e2b.dev/billing, read 16 Nov 2026). 20 matches neither, so the team has a custom limit. Creation is rate-limited to 5 per second on Pro.

## Verdict per target

| Target | Measured | Verdict |
| --- | --- | --- |
| Snapshot restore under 1 s at p95 | `Sandbox.create(snapshotId)`: p50 723 ms, p95 1,090 ms, p99 4,614 ms. To the first command: p95 1,668 ms. Pause → resume: p95 355 ms, p95 641 ms to the first command. | **Fail** for snapshot restore, by 90 ms at p95. **Pass** for resuming a paused box. |
| Per-chunk overhead under 300 ms | 3,620–3,914 ms at p50 and 4,356–4,851 ms at p95 per 1,000-row chunk, over the in-process chunk (about 1 ms). | **Fail**, 12× over at p50. |
| ES backfill within 1.5× of 3 h 54 min | 6 h 52 min at p50 overhead (1.76×). 7 h 30 min at p95 (1.92×). | **Fail** as built. The target allows 2.5 s per chunk. |
| Cost per backfill recorded | $0.92 on a 2 vCPU, 2 GiB box. $0.46 on the RFC's 1 vCPU, 1 GiB default. | Recorded. Cost is not the problem. |

The overhead is round trips, not compute. Fixing it is a change to `sync-box.ts` and the provider, not to E2B (see "What would change the RFC").

## Environment

| Item | Value |
| --- | --- |
| Date | 16 Nov 2026, 14:30–14:41 UTC |
| E2B SDK | `e2b` 2.55.0 (api/package.json `^2.55.0`) |
| Template | `mako-apps-v2` (`APPS_E2B_TEMPLATE` in local `.env`), 2 vCPU, 2,048 MB |
| Client | MacBook, Apple M5 Pro, macOS (Darwin 27.2.0, arm64), Node 24.22.1, in Europe |
| Code | `origin/master` 21a1d5172, worktree branch `bench/g1-box-overhead` |
| Chunk | 10 pages of 100 rows (1,000 rows), `maxIterations: 10` |
| Data | Synthetic, generated in the box by `connector/`. Email mean 32.4 KB per record, call mean 9.5 KB, from ES Close tables in BigQuery |

Mako's production API runs in GCP `europe-west1`. A raw E2B command takes 176 ms from this laptop. The API sees a similar transatlantic round trip, but this was not measured from `europe-west1`.

## Numbers

All times in milliseconds. n is the sample count.

### Box lifecycle

| Measure | n | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| Cold create from template (`Sandbox.create`) | 20 | 595 | 1,055 | 1,210 |
| Cold create to first command | 20 | 844 | 1,346 | 1,478 |
| Pause, memory kept (`Sandbox.pause`) | 20 | 359 | 640 | 843 |
| Resume (`Sandbox.connect` on a paused box) | 20 | 298 | 355 | 457 |
| Resume to first command | 20 | 480 | 641 | 946 |
| `createSnapshot` of a box with the runtime installed | 1 | 747 | – | – |
| Restore from snapshot (`Sandbox.create(snapshotId)`) | 20 | 723 | 1,090 | 4,614 |
| Restore to first command | 20 | 1,163 | 1,668 | 5,570 |
| Restore, then a 1-page read with the restored runtime | 20 | 742 | 1,076 | 1,613 |
| `fork()` of a running box | 10 | 1,372 | 2,216 | 2,216 |
| Fork to first command | 10 | 1,592 | 2,454 | 2,454 |

A restored box held the Node runtime, the SDK and the connector. Its first read needed no install.

### One round trip

| Measure | n | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| No-op through `provider.exec` (what `sync-box.ts` pays) | 50 | 522 | 565 | 974 |
| No-op through a held `Sandbox` handle (`commands.run`) | 50 | 176 | 181 | 223 |
| `Sandbox.connect` on a running box | 50 | 168 | 230 | 320 |
| Small file write on a held handle | 50 | 169 | 617 | 662 |

`provider.exec` costs 3 round trips: `Sandbox.connect`, `setTimeout`, then the command. `provider.writeFile` and `readFile` cost 2: `connect`, then the transfer.

### One chunk, end to end

`SandboxedConnector.fetchEntityChunk` on a warm box, 1,000 rows: write config, catalog and state, exec `read`, bounded read-back, parse, `onBatch`. 30 chunks per entity.

| Entity | In-process p50 | Local subprocess p50 | Boxed p50 | Boxed p95 | Boxed p99 | Boxed rows/s |
| --- | --- | --- | --- | --- | --- | --- |
| `fixed-1k` (1 KB rows, 1.1 MB per chunk) | 0.8 | 130 | 3,621 | 4,540 | 4,840 | 269 |
| `call` (9.5 KB mean, 9.6 MB per chunk) | 1.0 | 173 | 3,685 | 4,356 | 4,520 | 265 |
| `email` (32.4 KB mean, about 33 MB per chunk) | 1.1 | 344 | 3,914 | 4,851 | 5,286 | 246 |

Where a boxed chunk's time goes (p50, `call`):

| Provider call | Per chunk | p50 each |
| --- | --- | --- |
| `exec` mkdir of the run directory | 1 | 515 |
| `writeFile` config, catalog, state | 3 | 337 |
| `exec` the connector's `read` | 1 | 667 |
| `exec` `head -c` bound and `wc -c` | 1 | 529 |
| `readFile` of the bounded output | 1 | 416 |
| `exec` `rm -rf` of the run directory | 1 | 518 |
| **Total** | **8 calls, 20 round trips** | **3,685** |

The connector process itself runs for about 120–265 ms of the 667–786 ms `read` exec. The rest is round trips.

### Byte cap

4 of 30 `email` chunks (13%) exceeded `MAX_CONNECTOR_PROTOCOL_BYTES` (32 MiB) and failed. They fail the same way on retry, because the data is the same. The in-process Close connector has no such cap. Close's search API uses 200-row pages (`SEARCH_PAGE_SIZE` in `close/search.ts`), so 10 pages of Close emails average about 65 MB and would fail every time.

### Memory and CPU

Not measured in the box: the `metrics` phase was stopped with the run. On the laptop, one `email` chunk's process peaked at 95 MB RSS and used 90 ms of CPU. A `call` chunk peaked at 90 MB. A 1 vCPU, 1 GiB box has room for this.

### Parallel throughput

Not measured: shared 20-sandbox cap. One box ran 246–269 rows per second with no vendor latency at all.

## ES Close backfill, extrapolated

**Vendor-bound time.** The in-process backfill on 15 Nov 2026 ran 14,046 s (10:31:55 to 14:26:00 UTC, `flow_status` of `es-close-bigquery-write`).

**Rows it read.** Flow status gives 71,862,904 lifetime rows applied across 22 entities. That counts every backfill, resync and webhook since July. One backfill reads the current tables: 2,812,185 rows in `es_close_crm` on 16 Nov 2026 (BigQuery `TABLE_STORAGE`), including 826,143 emails and 682,916 calls. So the 15 Nov run read about 2.81M rows at 200 rows per second, which is 5.0 s of vendor time per 1,000-row chunk.

| Scenario | Chunks | Added box time | Total | vs 3 h 54 min |
| --- | --- | --- | --- | --- |
| 2.81M rows, 1,000-row chunks, p50 overhead 3.8 s | 2,813 | 2 h 58 min | 6 h 52 min | 1.76× |
| Same, p95 overhead 4.6 s | 2,813 | 3 h 36 min | 7 h 30 min | 1.92× |
| 2.81M rows, Close's 2,000-row chunks, p50 | 1,407 | 1 h 29 min | 5 h 23 min | 1.38×, but every email chunk breaks the 32 MiB cap |
| 71.9M lifetime rows, as briefed, p50 | 71,863 | 75 h 51 min | 79 h 45 min | 20.4× |
| 2.81M rows, 3-round-trip chunk, estimated 0.75 s | 2,813 | 35 min | 4 h 29 min | 1.15×, not measured |

The lifetime row count overstates one backfill 25-fold. The RFC's "about 1,500 chunk round trips" matches 2.81M rows at 2,000 rows per chunk.

All scenarios run entities one after another. Splitting entities across boxes (RFC §6.3) would divide the added time, but the shared cap leaves no room for it today.

The 3-round-trip estimate assumes one multi-file write, one command and one read on a held handle, at 176 ms each, plus 130–270 ms of process time. The `lean` phase in `run.mts` measures it. It did not run because of the cap.

## Cost

E2B prices, read from e2b.dev/pricing on 16 Nov 2026: $0.000014 per vCPU-second and $0.0000045 per GiB-second. Paused boxes cost nothing. Disk is free. Pro costs $150 per month plus usage.

| Box | Per second | Per hour |
| --- | --- | --- |
| 2 vCPU, 2 GiB (`mako-apps-v2`, measured) | $0.000037 | $0.133 |
| 1 vCPU, 1 GiB (RFC §6.6 default) | $0.0000185 | $0.067 |

| Case | 2 vCPU, 2 GiB | 1 vCPU, 1 GiB |
| --- | --- | --- |
| ES backfill, as built (24,735 box-seconds) | $0.92 | $0.46 |
| ES backfill, 3-round-trip estimate (16,156 s) | $0.60 | $0.30 |
| ES backfill, 71.9M lifetime rows (287,125 s) | $10.62 | $5.31 |
| 50 flows per day, daily resyncs only (50 × 700 s) | $1.30 | $0.65 |
| 5 webhook Close tenants with a warm box 10 h a day | $6.66 | $3.33 |
| 50 boxes running all day (ceiling; the cap forbids it) | $159.84 | $79.92 |

The 50-flow line assumes each flow's daily resync takes as long as ES Close's (392–465 s in-process on 15–16 Nov) plus 50% box overhead. Webhook batches are not counted beyond the warm boxes.

The benchmark itself created 54 boxes for a few seconds each and one warm box for 10 minutes. It cost under $0.05.

## App boxes, for comparison

| | App box | Connector box (G1) |
| --- | --- | --- |
| Template | `mako-apps` on the live team (14 running sessions). `mako-apps-v2` in local `.env` | `mako-apps-v2` |
| Size | 2 vCPU, 2,048 MB (`api/src/apps/e2b-template.ts` build options; confirmed by `Sandbox.list`) | Same box. The RFC wants 1 vCPU, 1 GiB |
| Disk | Not set in code. E2B gives 10 GiB on Hobby and 20 GiB on Pro | Same |
| Idle policy | 10 min idle timeout, then pause with memory (`e2b-provider.ts` `IDLE_TIMEOUT_MS`). Dev servers hold 30 min (`DEV_SESSION_KEEPALIVE_MS`). Workflow runs hold 60 min (`RUN_LIFETIME_MS`) | RFC: pause within 30–60 s of idle |
| Paused retention | Unlimited. E2B never deletes a paused box. The team holds 89 paused boxes, started a median 557 h (23 days) ago | RFC: 1–24 h TTL, then kill |
| Typical running lifetime | The 17 running non-bench boxes had been up a median 0.5 h, at most 0.8 h | Seconds per chunk, hours per backfill |
| Round trips per unit of work | A few per human action, seconds apart | 20 per chunk, 56,000 per ES backfill |

Why apps do not struggle: a person waits for one action at a time, so 500 ms per exec is invisible. A backfill pays a round trip 20 times per chunk and 2,813 times per backfill. The same box and provider serve both; only the call pattern differs.

## What would change the RFC

1. **Give connector boxes their own E2B team, or raise the cap first.** §6.6's "global ceiling below the E2B plan's sandbox limit" must count app sessions too. Today 17–19 of 20 slots are taken by apps. Without a separate team, any connector box can block an app preview.
2. **Build the lease around a held handle.** `e2b-provider.ts` calls `Sandbox.connect` and `setTimeout` on every exec. `runConnectorCommand` makes 8 provider calls. That is 20 round trips and 3.6–3.9 s per chunk. One write, one command and one read on a held handle is 3 round trips, about 0.75 s. Streaming the bounded output on stdout makes it 2. The `BoxProvider` in §6.8 should expose a lease object, not stateless calls by session key.
3. **The 300 ms target needs 1 round trip from the API.** One raw command costs 176 ms from Europe. Two round trips already exceed 300 ms. Either relax the target to about 750 ms, move to an E2B region near `europe-west1`, or make chunks larger.
4. **Chunk by bytes, not only by pages.** 13% of 1,000-row email chunks broke the 32 MiB cap. Close's real 2,000-row chunks would break it every time. The SDK needs a byte budget per chunk, or the engine must shrink `maxIterations` on a cap error.
5. **Snapshot restore misses 1 s by 90 ms at p95, with a 4.6 s p99.** Resuming a paused box hits 355 ms at p95. Prefer paused boxes over snapshot restores, as §6.3 already orders them. Keep the snapshot path off the P0 lease path.
6. **Use real backfill sizes, not lifetime rows.** ES Close holds 2.81M rows. Lifetime rows applied (71.9M) count every replay.

## Optional live Close check

Not run. No Close sandbox or test key exists in the local environment, and the production key is out of bounds.

## Boxes created and killed

| Run | Created | Killed |
| --- | --- | --- |
| Smoke run `g1-mwjczhhp` | 1 | 1 |
| Main run `g1-mwjd1w9b` | 53: 20 cold creates, 1 pause box, 1 snapshot source, 20 snapshot restores, 10 forks, 1 warm sync box | 53 |
| **Total** | **54** | **54** |

The one snapshot was deleted. A sweep of the team after the run found 0 boxes and 0 snapshots with either run's tag.
