# Realtime console sync — e2e harness

Manual end-to-end scenarios for the server-authoritative draft + poke-then-pull
realtime sync (PR #477 / issue #475 architecture). Two real browser windows,
real Monaco buffers, the real agent pipeline — driven deterministically by a
**mock AI gateway** with scripted tool calls instead of an LLM.

Each scenario asserts equality across the three replicas that matter
(**Monaco buffer ↔ zustand store ↔ server document**), so "looks fine" cannot
hide divergence. Run it whenever the sync layer changes:

- `consoleStore` / `realtimeStore` (apply gates, autosave, conflicts)
- `routes/consoles.ts` (PUT guards, revisions-sync)
- `server-console-tools.ts` / `console-execution.service.ts`
- `Chat.tsx` in-band console opening, `Console.tsx` editor wiring

## What is covered

| Scenario | Asserts |
|---|---|
| `01-draft-two-windows` | opening a draft elsewhere doesn't bump revisions; live A→B propagation; typist never sees a false conflict |
| `02-saved-console` | clean windows live-apply explicit saves; dirty windows get the banner (no clobber); stale Cmd+S → conflict dialog |
| `03-agent-modalities` | create/modify/run/set-connection/open: Monaco shows agent edits, results render, user↔agent edits interleave without loss, tab stays a draft |
| `04-dead-sse` | consoles created during a silently-dead SSE still appear (in-band chat stream); liveness watchdog reconnects ≲85s and repairs missed pokes (~2 min, real time) |
| `05-stale-save-dual-guard` | agent edits (draftRevision-only) can't be silently reverted by a stale Cmd+S (dual version+draftRevision guard) |
| `99-modify-dead-sse-repro` | agent `modify_console` surfaces LIVE even when the realtime poke channel is dead — the chat stream drives an in-band revision sync (regression for "create showed instantly, modify did nothing until refresh") |

## One-time setup

1. **MongoDB as a single-node replica set** (transactions are required):

   ```bash
   mongod --dbpath ~/mongo-data --port 27018 --replSet rs0 --fork --logpath ~/mongod.log
   mongosh --port 27018 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]})'
   # seed sample data the scenarios query:
   mongosh --port 27018 sampledb --eval 'db.users.insertMany([{name:"Alice",age:31},{name:"Bob",age:27},{name:"Carol",age:45}])'
   ```

2. **Root `.env`** — point the API at the replica set and the mock gateway:

   ```env
   DATABASE_URL=mongodb://localhost:27018/mako?replicaSet=rs0
   AI_GATEWAY_API_KEY=dummy-key-for-local-testing
   AI_GATEWAY_BASE_URL=http://localhost:9099
   SESSION_SECRET=<openssl rand -hex 32>
   ENCRYPTION_KEY=<openssl rand -hex 32>
   ```

3. **Run the stack** (three processes):

   ```bash
   pnpm api:dev          # API on :8080
   pnpm app:dev          # Vite on :5173
   node scripts/realtime-e2e/mock-gateway.mjs   # mock gateway on :9099
   ```

4. **Provision a user + workspace + connection** (writes `.env.e2e` here):

   ```bash
   cd scripts/realtime-e2e && npm install
   node setup.mjs register e2e@example.com 'Password123!'
   # without SendGrid configured the code is only stored in Mongo:
   mongosh --port 27018 mako --eval 'db.emailverifications.find().sort({createdAt:-1}).limit(1).toArray()'
   node setup.mjs verify e2e@example.com <code>
   node setup.mjs provision <session> 'mongodb://localhost:27018/sampledb?replicaSet=rs0' sampledb
   ```

5. A Chrome/Chromium binary. Default path is `/usr/local/bin/google-chrome`;
   override with `MAKO_E2E_CHROME=/path/to/chrome`.

## Running

```bash
node run-all.mjs          # everything (~4 min)
node 01-draft-two-windows.mjs   # one scenario
```

Each check prints `[PASS]`/`[FAIL]`; a scenario exits non-zero on any failure.
Screenshots land in `shots/`.

## Notes & gotchas

- **Vite HMR caveat:** some scenarios read live stores via
  `import("/src/store/…")` from the page. After editing store files, restart
  the Vite dev server first — HMR's `?t=` stamps would otherwise give the
  probe a *second* module instance with empty state.
- The harness is deliberately **not** wired into CI: it needs a full local
  stack (replica-set Mongo, two dev servers, Chrome). It is the regression
  net for the realtime layer — run it before merging changes there.
- Scenario 04 takes ~2 minutes of wall-clock time by design (the SSE
  liveness watchdog fires after 70s of silence + ≤15s sweep interval).
- The mock gateway protocol targets `@ai-sdk/gateway`'s LanguageModelV3
  endpoint (`POST /language-model`, SSE stream parts). If the gateway SDK
  majors, re-check the stream part shapes in
  `node_modules/@ai-sdk/provider/dist/index.d.ts`.
