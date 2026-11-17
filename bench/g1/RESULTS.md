# G1 results: E2B box overhead for connector chunks

## Third run, 17 Nov 2026: E2B EU (europe-west1) against us-west-1

EU boxes cut a round trip from 173 ms to 17 ms, and a warm `call` chunk from 882 ms to 365 ms. Raw resume and lease resume pass 1 s. Snapshot restore misses 1 s at p95 by 20 ms. The 300 ms chunk target passes for 1 KB rows and fails for Close-sized rows.

Runs, all from one GCE e2-standard-4 VM in `europe-west1-b`, master c13ab8ce2, template `mako-apps` (2 vCPU, 2,048 MB), `e2b` 2.55.0. EU and US ran minutes apart on the same VM and code:

| Run | E2B project, region | When (UTC) | Raw numbers |
| --- | --- | --- | --- |
| Raw SDK (`run.mts --phases create,pause,snapshot,exec`) | `mako-dev`, us-west-1 | 06:57–07:00 | [`results/2026-11-17-eu-baseline-us-west-1-raw.json`](./results/2026-11-17-eu-baseline-us-west-1-raw.json) |
| Raw SDK, same phases | `mako-eu`, EU (`E2B_DOMAIN=e2b-juliett.dev`) | 07:04–07:06 | [`results/2026-11-17-eu-raw.json`](./results/2026-11-17-eu-raw.json) |
| Chunk path (`run-v2.mts`), flag off and on | `mako-eu`, EU | 07:05–07:12 | [`results/2026-11-17-eu-v2.json`](./results/2026-11-17-eu-v2.json) |
| Chunk path, flag off and on | `mako-dev`, us-west-1 | 07:13–07:28 | [`results/2026-11-17-eu-baseline-us-west-1-v2.json`](./results/2026-11-17-eu-baseline-us-west-1-v2.json) |

The US chunk path was re-run because master changed since 16 Nov. PR 1303 removed the `ping` and the 2 marker checks from a warm flag-on chunk, so flag on now costs 915 ms on US, not 1,392 ms.

### The EU project

- E2B serves each region from its own API domain. EU-West-1 is `e2b-juliett.dev` (docs.e2b.dev/client, read 17 Nov 2026). A project and its key belong to one region. The EU key fails on `api.e2b.app` with "Cannot get the team for the given API key".
- The SDK reads the domain from `E2B_DOMAIN`. It is already in the SDK's `supportedDomains`, so commands use the `sandbox.e2b-juliett.dev` proxy like US boxes use `sandbox.e2b.app`.
- An EU box's egress IP geolocates to Brussels on Google (AS396982), the same metro as `europe-west1`.
- `mako-apps` was built in `mako-eu` with `E2B_DOMAIN=e2b-juliett.dev pnpm --filter api run apps:build-template`. Template `modykw6f7096ymjf2dan`, build `8b00de4b-bbad-4bd7-89fe-d03269bb7f27`. The runbook smoke test passed: Node v24.22.1, pnpm 10.33.3, `app-dir-ok`, 2 vCPU, 1,982 MB.

### Verdict per target

| Target | us-west-1 (17 Nov) | EU | Verdict in EU |
| --- | --- | --- | --- |
| Snapshot restore under 1 s at p95 | `Sandbox.create(snapshotId)` p95 1,672 ms | p95 1,020 ms, p50 496 ms | **Fail**, by 20 ms |
| | Raw resume of a paused box p95 707 ms | p95 248 ms | **Pass** |
| | Lease resume (the `ping` that resumes) p95 1,266 ms | p95 335 ms | **Pass** |
| | Lease restore from template (`lifecycle.create`) p95 2,555 ms | p95 1,568 ms | **Fail** |
| Per-chunk overhead under 300 ms | Warm `call` 882 ms p50 flag off, 915 ms flag on | `fixed-1k` 268 / 295 ms p50 / p95 flag off, 261 / 277 ms flag on | **Pass** for 1 KB rows |
| | | `call` 365 / 420 ms flag off, 357 / 395 ms flag on. `email` 474 / 521 ms, 481 / 511 ms | **Fail**, 57–181 ms over at p50 |
| ES backfill within 1.5× of 3 h 54 min | 1.23× flag off (16 Nov) | 1.10× flag off and flag on at p50, 1.11× at p95 | **Pass** |

### Before and after, same VM, same code

#### One round trip

| Measure | us-west-1 p50 / p95 | EU p50 / p95 | Change at p50 |
| --- | --- | --- | --- |
| No-op through `provider.exec` (`run-v2`, warm box) | 173 / 196 | 17 / 21 | 10× faster |
| No-op through `provider.exec` (`run.mts`) | 176 / 641 | 20 / 23 | 9× |
| No-op on a held handle (`commands.run`) | 174 / 197 | 19 / 24 | 9× |
| `Sandbox.connect` on a running box | 188 / 720 | 16 / 22 | 12× |
| Small file write on a held handle | 188 / 720 | 11 / 14 | 17× |

#### Warm chunk, 1,000 rows (`email`: 573 mean under the 16 MiB byte budget), 30 chunks each

| Path | `fixed-1k` us / EU | `call` us / EU | `email` us / EU |
| --- | --- | --- | --- |
| Flag off, p50 | 786 / 268 | 882 / 365 | 940 / 474 |
| Flag off, p95 | 1,260 / 295 | 1,088 / 420 | 1,084 / 521 |
| Flag on, p50 | 812 / 261 | 915 / 357 | 1,019 / 481 |
| Flag on, p95 | 903 / 277 | 1,084 / 395 | 1,125 / 511 |

#### Box lifecycle (raw SDK, n = 20, fork n = 10)

| Measure | us-west-1 p50 / p95 | EU p50 / p95 |
| --- | --- | --- |
| Cold create from template | 571 / 1,088 | 391 / 533 |
| Cold create to first command | 806 / 1,854 | 457 / 716 |
| Pause, memory kept | 512 / 869 | 172 / 325 |
| Resume (`Sandbox.connect` on a paused box) | 514 / 707 | 125 / 248 |
| Resume to first command | 710 / 887 | 148 / 270 |
| Restore from snapshot (`Sandbox.create(snapshotId)`) | 984 / 1,672 | 496 / 1,020 |
| Restore to first command | 1,312 / 2,141 | 636 / 1,319 |
| Restore, then a 1-page read | 713 / 1,141 | 741 / 2,707 |
| `fork()` of a running box | 1,159 / 2,189 | 505 / 2,302 |

#### Cold chunk paths (`run-v2`)

| Start | us-west-1 p50 / p95 | EU p50 / p95 |
| --- | --- | --- |
| Flag off, new sync box: create, Node download, SDK, folder, first chunk (3 runs) | 16,957 (12,179–17,366) | 4,409 (4,277–5,281) |
| Flag off, chunk on a paused sync box (resume inside) | 1,838 / 2,849 | 624 / 1,396 |
| Flag on, new connection: create, Node download, SDK writes, snapshot, chunk (n = 3) | 12,721 / 18,730 | 6,555 / 6,926 |
| Flag on, chunk after the idle box paused (n = 10) | 2,474 / 3,456 | 691 / 5,102 |
| Flag on, chunk after the box died (restore from template, n = 10) | 5,085 / 6,369 | 2,679 / 6,170 |

The EU flag-on after-pause p95 is 1 slow chunk of 10. Its resume `ping` stayed under 335 ms, so the time went elsewhere in that chunk. The cause is not isolated. Node's download still costs 3,974 ms of an EU new connection. It belongs in the template (point 3 of the second run).

### Where an EU warm chunk's time goes (`call`, flag off, 365 ms p50)

| Part | ms | Share | Source |
| --- | --- | --- | --- |
| Write the inputs (`writeFiles`) | 13 | 4% | provider trace |
| Exec round trip | 17 | 5% | `providerExecNoopMs` |
| Read the bounded output back (`readFile`, 9.6 MB) | 76 | 21% | provider trace |
| **Transport** | **106** | **29%** | |
| Connector boot: Node start and SDK import | 89 | 24% | `boot` phase |
| Connector work: generate and serialise 10 pages | 50 | 14% | `boot` read 139 ms minus boot |
| Per-run isolation: user, run directory, kill loop, bound, cleanup | 102 | 28% | exec 258 ms minus 17 ms round trip minus 139 ms process |
| Client: parse 1,000 records and `onBatch` | 18 | 5% | remainder |

Transport fell from 600 ms (65%) on us-west-1 to 106 ms (29%). The box's own work is now 241 ms, or 66% of the chunk. To reach 300 ms for Close-sized rows, cut that work next. A long-lived connector process saves up to 89 ms of boot. A run user that outlives one chunk saves part of the 102 ms of isolation. Together they would bring `call` near 200–250 ms.

### Parallel throughput (warm boxes, 30 chunks per box)

| Boxes | `call` rows/s us / EU | `email` rows/s us / EU | `call` chunk p50 us / EU |
| --- | --- | --- | --- |
| 1 connection, flag on | 1,070 / 2,591 | 569 / 1,180 | 921 / 377 ms |
| 2 connections | 2,138 / 5,271 | 1,141 / 2,147 | 870 / 375 ms |
| 4 connections | 4,260 / 9,236 | 2,155 / 3,924 | 876 / 422 ms |
| 8 connections | 8,382 / 12,735 | 4,006 / 4,759 | 894 / 607 ms |
| 1 sync box, 1 chunk at a time, flag off | 574 / 2,256 | – | 1,588 / 438 ms |
| 1 sync box, 2 chunks at once | 1,314 / 4,170 | – | 1,513 / 470 ms |
| 1 sync box, 4 chunks at once | 2,583 / 5,271 | – | 1,529 / 740 ms |

EU throughput scales 4.9× from 1 to 8 boxes for calls, against 7.8× on us-west-1. EU chunk latency rises from 377 ms to 607 ms at 8 boxes. The 4 vCPU client parses 12,735 rows per second at that point, so the client is the likely limit. This run does not separate client from box.

### ES backfill, extrapolated

Same method as the second run: 14,046 s of vendor time, plus 1,441 email chunks and 1,986 other chunks at the measured EU `email` and `call` chunk times.

| Path (EU) | Added | Total | vs 3 h 54 min | Cost, 2 vCPU/2 GiB |
| --- | --- | --- | --- | --- |
| Flag off, p50 | 23 min | 4 h 18 min | 1.10× | $0.57 |
| Flag off, p95 | 26 min | 4 h 21 min | 1.11× | $0.58 |
| Flag on, p50 | 23 min | 4 h 17 min | 1.10× | $0.57 |
| Flag on, p95 | 25 min | 4 h 19 min | 1.11× | $0.58 |

Cost uses the US prices from the first run. EU prices were not checked.

### Boxes created and killed

| Run | Created | Killed or deleted |
| --- | --- | --- |
| Key and domain probe, template smoke test (EU) | 2 boxes | 2 |
| Raw SDK, EU | 53 boxes, 1 snapshot | 53, 1 |
| `run-v2`, EU | 26 boxes, 13 snapshots | 26, 13 |
| Raw SDK smoke run from a laptop, then the VM run, us-west-1 | 9 + 53 boxes, 2 snapshots | 62, 2 |
| `run-v2`, us-west-1 | 27 boxes, 13 snapshots | 27, 13 |

After the runs, the account check showed 0 boxes and 0 snapshots in both `mako-eu` and `mako-dev`.

### How the third run was made

- The VM `g1-bench-eu` ran as a dedicated service account. That account held `secretAccessor` on `E2B_API_KEY_EU` only and read the key into the process environment on the VM. The `mako-dev` key reached the VM over ssh stdin, as in the README. Neither key was printed or written to a file.
- The VM, its service account and the secret binding were deleted after the run.
- `run.mts`'s raw-SDK phases ran on master. They import `sync-box.ts`, but these 4 phases call none of the internals that 3608123c1 changed.

## Second run, 16 Nov 2026 evening: after PR 1278 and PR 1284 (master 3608123c1)

A warm chunk is 4.3–4.6× faster than on the old path, and the ES backfill target now passes. Per-chunk overhead and snapshot restore still fail.

Runs, all on the `mako-dev` project (Pro plan, 100-box limit, no users), template `mako-apps` (2 vCPU, 2,048 MB), `e2b` 2.55.0:

| Run | Client | When (UTC) | Raw numbers |
| --- | --- | --- | --- |
| Old path (`run.mts` on code before 3608123c1) | MacBook in Europe | 20:58–21:07 | [`results/2026-11-16-old-path-mako-dev.json`](./results/2026-11-16-old-path-mako-dev.json) |
| New path (`run-v2.mts`), flag off and on | MacBook in Europe | 21:07–21:24 | [`results/2026-11-16-v2-laptop.json`](./results/2026-11-16-v2-laptop.json) |
| New path (`run-v2.mts`), flag off and on | GCE e2-standard-4, `europe-west1-b` | 21:25–21:42 | [`results/2026-11-16-v2-europe-west1.json`](./results/2026-11-16-v2-europe-west1.json) |

At most 10 boxes ran at once. The three runs created 107 boxes and 27 snapshots, and a smoke run 2 boxes and 1 snapshot. All were killed or deleted, and the project held 0 boxes and 0 snapshots afterwards.

### Verdict per target

Numbers are from europe-west1, where the API runs, unless marked.

| Target | Measured | Verdict |
| --- | --- | --- |
| Snapshot restore under 1 s at p95 | `Sandbox.create(snapshotId)`: p95 1,727 ms (old run, laptop). Lease restore from template: `lifecycle.create` p95 2,926 ms. Raw resume of a paused box: p95 452 ms. Lease resume (the ping that resumes): p95 1,165 ms | **Fail.** Raw resume passes |
| Per-chunk overhead under 300 ms | Warm chunk, flag off: 917–978 ms p50, 1,065–1,068 ms p95. Flag on: 1,392–1,494 ms p50, 1,481–1,881 ms p95 | **Fail**, 3.1× over flag off |
| ES backfill within 1.5× of 3 h 54 min | Flag off: 4 h 47 min at p50 (1.23×), 4 h 54 min at p95 (1.26×). Flag on: 5 h 16 min (1.35×), 5 h 29 min (1.41×) | **Pass** both ways |
| Cost per backfill | $0.64 flag off, $0.70 flag on, on 2 vCPU/2 GiB. Half that on 1 vCPU/1 GiB | Recorded |

### Warm chunk, old vs new

1,000 rows (email: up to the 16 MiB byte budget), 30 chunks per row of the table.

| Path | Client | `fixed-1k` p50 / p95 | `call` p50 / p95 | `email` p50 / p95 | Email rows per chunk |
| --- | --- | --- | --- | --- | --- |
| Old (8 calls, 20 round trips) | laptop | 3,538 / 4,854 | 3,607 / 4,639 | 3,790 / 4,404 | 1,000; 4 of 30 over the 32 MiB cap |
| New, flag off | laptop | 773 / 1,282 | 822 / 995 | 881 / 1,068 | 573 mean, 500 min; 0 over the cap |
| New, flag off | europe-west1 | 782 / 1,073 | 917 / 1,065 | 978 / 1,068 | 573 mean, 500 min; 0 over the cap |
| New, flag on | laptop | 1,263 / 1,418 | 1,343 / 1,492 | 1,403 / 1,490 | 563 mean; 0 over the cap |
| New, flag on | europe-west1 | 1,268 / 1,307 | 1,392 / 1,481 | 1,494 / 1,881 | 563 mean; 0 over the cap |

The in-process chunk takes about 1 ms, so the box time is the overhead.

### Where a warm chunk's time goes (europe-west1, `call`, flag off, 917 ms p50)

| Part | ms | Share | Source |
| --- | --- | --- | --- |
| Write the inputs (`writeFiles`, 1 round trip) | 164 | 18% | provider trace |
| Exec round trip (a no-op `exec` costs 165 ms) | 165 | 18% | `providerExecNoopMs` |
| Read the bounded output back (`readFile`, 9.6 MB) | 271 | 30% | provider trace |
| **Transport** | **600** | **65%** | |
| Connector boot: Node start 27 ms, SDK and connector import 73 ms | 100 | 11% | `boot` phase, in the box |
| Connector work: generate and serialise 10 pages | 53 | 6% | `boot` read 153 ms minus boot |
| Per-run isolation: user, run directory, kill loop, bound, cleanup | 131 | 14% | exec 449 ms minus 165 ms round trip minus 153 ms process |
| Client: parse 1,000 records and `onBatch` | 33 | 4% | remainder |

Flag on adds 3 round trips before the chunk: a `ping` (174 ms) and 2 marker checks from `ensureBundle` (runtime and folder, 172 ms each). That is 519 ms, all transport, and it puts transport at 80% of the flag-on chunk.

A long-lived connector process can save at most the 100 ms of boot, 11% of the flag-off chunk and 7% of the flag-on chunk. It would save part of the 131 ms of isolation only if a run user outlived one chunk.

### Region

europe-west1 does not shorten the round trip. A no-op exec costs 165 ms p50 from the GCE VM and 174 ms from the laptop. TCP connect to `api.e2b.app` takes 2–3 ms from the VM, so the load balancer is near and the sandboxes are not. The RTT is set by where E2B runs the boxes.

### Cold paths

| Start | europe-west1 p50 | p95 | Laptop p50 |
| --- | --- | --- | --- |
| Flag off, new workspace sync box: create, Node download, SDK, folder, first chunk | 12,884 ms (3 runs: 10,975–12,897) | – | 9,622 ms |
| Flag off, chunk on a paused sync box (resume inside) | 1,816 | 2,003 | 1,867 |
| Flag on, new connection: create 1,074, Node download 3,636, 19 SDK file writes, snapshot 1,473, chunk | 12,378 | 13,325 | 11,973 |
| Flag on, chunk after the idle box paused (resume via ping 820 ms) | 2,276 | 3,101 | 2,336 |
| Flag on, chunk after the box died (restore from template, `lifecycle.create` 1,637 ms) | 4,868 | 6,241 | 4,531 |

Raw SDK numbers on `mako-dev` (laptop, old run): cold create 586 ms p50 and 714 ms p95; to the first command 798 ms and 1,234 ms. Pause 380 ms p50. Resume 301 ms p50 and 452 ms p95. Snapshot restore 875 ms p50 and 1,727 ms p95. Fork 1,085 ms p50 and 1,386 ms p95.

### Parallel throughput (europe-west1, warm boxes, 30 chunks per box)

| Boxes | `call` rows/s | `email` rows/s | Chunk p50 |
| --- | --- | --- | --- |
| 1 connection, flag on | 750 | 411 | 1,295 ms |
| 2 connections | 1,494 | 799 | 1,315 ms |
| 4 connections | 2,830 | 1,518 | 1,353 ms |
| 8 connections | 5,597 | 2,817 | 1,356 ms |
| 1 sync box, 1 chunk at a time, flag off | 598 | – | 1,598 ms |
| 1 sync box, 2 chunks at once | 1,323 | – | 1,500 ms |
| 1 sync box, 4 chunks at once | 2,446 | – | 1,587 ms |

Throughput scales 7.5× from 1 to 8 boxes for calls and 6.9× for emails. Chunk latency barely moves. One 2 vCPU sync box runs 4 chunks at once at 4.1× the rate of one.

The flag-off rows ran on a box that had just been paused and resumed 10 times. Its chunks took 1,598 ms p50 against 917 ms on the same box before the pauses. The cause is not isolated. A resumed memory snapshot that pages back in lazily would explain it.

### ES backfill, extrapolated

Same method as the first run: 14,046 s of vendor time for 2.81M rows, plus chunks times the measured chunk time. With the 16 MiB byte budget an email chunk holds 573 rows on average, so the 826,143 emails need 1,441 chunks. The other 1,986,042 rows need 1,986. That is 3,427 chunks, and the 1.5× target allows 2.04 s each.

| Path (europe-west1) | Added | Total | vs 3 h 54 min | Cost, 2 vCPU/2 GiB |
| --- | --- | --- | --- | --- |
| Flag off, p50 | 54 min | 4 h 47 min | 1.23× | $0.64 |
| Flag off, p95 | 1 h 1 min | 4 h 54 min | 1.26× | $0.65 |
| Flag on, p50 | 1 h 23 min | 5 h 16 min | 1.35× | $0.70 |
| Flag on, p95 | 1 h 35 min | 5 h 29 min | 1.41× | $0.73 |

These run entities one after another. Splitting entities across boxes divides the added time by up to the box count (§6.3).

### What would cut the rest

1. **Drop the 3 lease round trips on a warm box.** The `ping` and the two `ensureBundle` marker checks cost 519 ms per flag-on chunk. A box this process leased and released seconds ago needs neither. Doing the marker check inside the chunk command would keep it safe.
2. **Return the bounded output on stdout.** That makes a chunk 2 round trips, not 3, and saves about 165 ms plus the separate download.
3. **Make the cold start a snapshot.** A new connection pays 3.6 s to download Node and 19 one-file writes for the SDK. Both belong in the template.
4. **The connector process is 11% of a warm chunk.** A long-lived process saves at most 100 ms of boot. Transport is 65–80%.
5. **300 ms per chunk needs boxes near the API.** One round trip is 165 ms from europe-west1, and a chunk needs at least 2.

### How the second run was made

- `run-v2.mts` drives `SandboxedConnector.fetchEntityChunk` on master. It replaces only the Mongo/git lookups of the connector's definition and folder.
- Flag on runs the real `BoxScheduler`. Its Mongo store is swapped for `MemoryBoxStore`, which the scheduler's tests use and which has the same compare-and-set semantics. Production adds a Mongo round trip per store call; this run does not measure that.
- The scheduler's account ceiling was set to the 10-box budget (`CONNECTOR_BOX_ACCOUNT_CEILING=10`, `CONNECTOR_BOX_APP_RESERVE=0`). The script also checks running boxes before every box it starts.
- The key came from Secret Manager into the process environment only. On the VM it arrived over ssh stdin.
- The VM was created for the run and deleted after it.

## First run, 16 Nov 2026 afternoon (code before PR 1278)

Run `g1-mwjd1w9b`, 16 Nov 2026, 14:30–14:41 UTC. Raw numbers: [`results/2026-11-16.json`](./results/2026-11-16.json).

### Top finding: connector boxes share a 20-sandbox cap with live app sessions

- The E2B team behind the local-development key caps concurrent sandboxes at 20. E2B's API said so when the benchmark asked for a third box: "you have reached the maximum number of concurrent E2B sandboxes (20)".
- That team runs real users' app sessions. At 14:32 UTC it held 17 running sandboxes besides this benchmark: 14 app sessions on `mako-apps`, 2 on `aura-sandbox` and 1 connector sync box. Minutes after the run stopped it held 19.
- Two connector boxes would have filled it. A Close backfill on 2–4 boxes (RFC §6.3) would refuse new app previews with "Rate limit exceeded".
- The benchmark stopped at that point. It started no more boxes. Parallel throughput is **not measured: shared 20-sandbox cap**. The `lean` and `metrics` phases did not run either.
- The documented tiers are 10 concurrent sandboxes on Hobby and 100–1,100 on Pro (docs.e2b.dev/billing, read 16 Nov 2026). 20 matches neither, so the team has a custom limit. Creation is rate-limited to 5 per second on Pro.

### Verdict per target

| Target | Measured | Verdict |
| --- | --- | --- |
| Snapshot restore under 1 s at p95 | `Sandbox.create(snapshotId)`: p50 723 ms, p95 1,090 ms, p99 4,614 ms. To the first command: p95 1,668 ms. Pause → resume: p95 355 ms, p95 641 ms to the first command. | **Fail** for snapshot restore, by 90 ms at p95. **Pass** for resuming a paused box. |
| Per-chunk overhead under 300 ms | 3,620–3,914 ms at p50 and 4,356–4,851 ms at p95 per 1,000-row chunk, over the in-process chunk (about 1 ms). | **Fail**, 12× over at p50. |
| ES backfill within 1.5× of 3 h 54 min | 6 h 52 min at p50 overhead (1.76×). 7 h 30 min at p95 (1.92×). | **Fail** as built. The target allows 2.5 s per chunk. |
| Cost per backfill recorded | $0.92 on a 2 vCPU, 2 GiB box. $0.46 on the RFC's 1 vCPU, 1 GiB default. | Recorded. Cost is not the problem. |

The overhead is round trips, not compute. Fixing it is a change to `sync-box.ts` and the provider, not to E2B (see "What would change the RFC").

### Environment

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

### Numbers

All times in milliseconds. n is the sample count.

#### Box lifecycle

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

#### One round trip

| Measure | n | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| No-op through `provider.exec` (what `sync-box.ts` pays) | 50 | 522 | 565 | 974 |
| No-op through a held `Sandbox` handle (`commands.run`) | 50 | 176 | 181 | 223 |
| `Sandbox.connect` on a running box | 50 | 168 | 230 | 320 |
| Small file write on a held handle | 50 | 169 | 617 | 662 |

`provider.exec` costs 3 round trips: `Sandbox.connect`, `setTimeout`, then the command. `provider.writeFile` and `readFile` cost 2: `connect`, then the transfer.

#### One chunk, end to end

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

#### Byte cap

4 of 30 `email` chunks (13%) exceeded `MAX_CONNECTOR_PROTOCOL_BYTES` (32 MiB) and failed. They fail the same way on retry, because the data is the same. The in-process Close connector has no such cap. Close's search API uses 200-row pages (`SEARCH_PAGE_SIZE` in `close/search.ts`), so 10 pages of Close emails average about 65 MB and would fail every time.

#### Memory and CPU

Not measured in the box: the `metrics` phase was stopped with the run. On the laptop, one `email` chunk's process peaked at 95 MB RSS and used 90 ms of CPU. A `call` chunk peaked at 90 MB. A 1 vCPU, 1 GiB box has room for this.

#### Parallel throughput

Not measured: shared 20-sandbox cap. One box ran 246–269 rows per second with no vendor latency at all.

### ES Close backfill, extrapolated

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

### Cost

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

### App boxes, for comparison

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

### What would change the RFC

1. **Give connector boxes their own E2B team, or raise the cap first.** §6.6's "global ceiling below the E2B plan's sandbox limit" must count app sessions too. Today 17–19 of 20 slots are taken by apps. Without a separate team, any connector box can block an app preview.
2. **Build the lease around a held handle.** `e2b-provider.ts` calls `Sandbox.connect` and `setTimeout` on every exec. `runConnectorCommand` makes 8 provider calls. That is 20 round trips and 3.6–3.9 s per chunk. One write, one command and one read on a held handle is 3 round trips, about 0.75 s. Streaming the bounded output on stdout makes it 2. The `BoxProvider` in §6.8 should expose a lease object, not stateless calls by session key.
3. **The 300 ms target needs 1 round trip from the API.** One raw command costs 176 ms from Europe. Two round trips already exceed 300 ms. Either relax the target to about 750 ms, move to an E2B region near `europe-west1`, or make chunks larger.
4. **Chunk by bytes, not only by pages.** 13% of 1,000-row email chunks broke the 32 MiB cap. Close's real 2,000-row chunks would break it every time. The SDK needs a byte budget per chunk, or the engine must shrink `maxIterations` on a cap error.
5. **Snapshot restore misses 1 s by 90 ms at p95, with a 4.6 s p99.** Resuming a paused box hits 355 ms at p95. Prefer paused boxes over snapshot restores, as §6.3 already orders them. Keep the snapshot path off the P0 lease path.
6. **Use real backfill sizes, not lifetime rows.** ES Close holds 2.81M rows. Lifetime rows applied (71.9M) count every replay.

### Optional live Close check

Not run. No Close sandbox or test key exists in the local environment, and the production key is out of bounds.

### Boxes created and killed

| Run | Created | Killed |
| --- | --- | --- |
| Smoke run `g1-mwjczhhp` | 1 | 1 |
| Main run `g1-mwjd1w9b` | 53: 20 cold creates, 1 pause box, 1 snapshot source, 20 snapshot restores, 10 forks, 1 warm sync box | 53 |
| **Total** | **54** | **54** |

The one snapshot was deleted. A sweep of the team after the run found 0 boxes and 0 snapshots with either run's tag.
