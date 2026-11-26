# RFC: Incremental Migration from MongoDB Atlas to Neon Postgres

- **Status:** Phase 0 Foundation Implemented (`feat/postgres-migration`)
- **Date:** 2026-11-26
- **Scope:** Migrate Mako's platform control plane (Workspaces & Users, Charts/Consoles & Workspace Metadata, Usage Stats, and Chat) from MongoDB Atlas to Neon Postgres without a big-bang cutover, while explicitly excluding Webhooks/CDC and already git-retired collections.

---

## 1. Motivation & Constraints

As documented in [`apps.md`](../apps.md) ("End-state platform: Postgres + GitHub, no Mongo"), Mako's long-term control plane is **Neon Postgres** (Drizzle ORM) and its file data plane is **GitHub**. Moving off MongoDB Atlas unlocks:

1. **Relational integrity & eliminating the 16 MB BSON limit**: Chat histories (`chats.messages[]`) previously hit silent BSON document caps, requiring emergency stripping and careful projections. Normalizing `chats` + `chat_messages` + `chat_usage_entries` + `chat_attachments` removes that ceiling permanently.
2. **Real SQL aggregations & native vector/full-text search**: Replaces Mongo `.aggregate()` pipelines on `llmusages` and `query_executions` with SQL `GROUP BY`, and replaces Atlas `$vectorSearch` / `$text` on `savedconsoles` with `pgvector` HNSW + `tsvector` GIN.
3. **Instant copy-on-write branching**: Replaces slow Mongo Atlas `staging_pr_<N>` preview databases with sub-second Neon branches (`scripts/neon-branch.ts`), plus 50ms in-process `@electric-sql/pglite` unit/contract tests instead of flaky `MongoMemoryServer` launches.
4. **Zero-downtime, workspace-by-workspace cutover**: No single cutover date; every domain supports 5-stage dual-run rollout with <1s zero-data-loss rollback.

### Hard External Constraints Discovered in Codebase Audit

1. **Custom in-repo auth (not BetterAuth/Clerk)**: `api/src/auth/session.ts` & `auth.service.ts` use mixed non-ObjectId string `users._id` (15-char Lucia IDs from `generateId(15)` + `randomUUID()` defaults) and 64-hex `sessions._id` (1-year cookie lifetime). Changing session/user IDs would log out every user and break `user:<id>` principals.
2. **Hard 24-hex ObjectId boundaries**:
   - Browser client mints `chatId` and `consoleId`/`tabId` client-side (`app/src/utils/objectId.ts`).
   - Cloudflare edge router validates `<appId>.<APPS_DOMAIN>` against `/^[0-9a-f]{24}$/` (`cloudflare/app-router/worker.mjs:113`).
   - CLI (`packages/cli/src/{connection,publish}.js`), App SDK (`packages/app-sdk/vite.js:138`), git manifests (`mako.json`, `consoles/*.sql`, `flows/*.yml`), and keyset pagination cursors (`api/src/services/chat-list.service.ts`) enforce 24-hex IDs.
3. **Arbitrary 96-bit ObjectIds exist**: `derivedAppId()` (`api/src/apps/app-paths.ts:164`) and `derivedConsoleId()` (`api/src/apps/workspace-consoles/definitions.ts:36`) hash SHA-1 prefixes into 24-hex `Types.ObjectId`s, meaning the upper 32 bits can hold **any `uint32` value (`0x00000000..0xFFFFFFFF`)**, not just current Unix timestamps.
4. **Mongo-specific surface is small and clean**: 0 Change Streams, only 4 multi-doc transactions (all in `api/src/services/workspace.service.ts`), 1 `$vectorSearch` (`savedconsoles`), 1 `$text` (`savedconsoles`), and 16 non-CDC TTL collections (replaced by our batched `ctid` TTL reaper + query-time `expires_at > now()` predicates).

---

## 2. Bijective MongoDB ObjectId ↔ Postgres UUID Codec (RFC 9562 UUIDv8)

Implemented in `api/src/database/pg/id-codec.ts` and `api/src/database/pg/migrations/0000_objectid_uuid_codec.sql`.

### 2.1 Bit Layout

Decompose any 96-bit MongoDB ObjectId `O` (24 lowercase hex chars) into:
- `T`: bytes `0..3` (32-bit unsigned big-endian integer, hex chars `0..7`)
- `P`: bytes `4..11` (64 bits = 5-byte random + 3-byte counter, 16 hex chars `P0..P15`)

Map `O = (T, P)` into a 128-bit RFC 9562 **UUIDv8**:

| Bit Range | Width | Hex Pos | Field | Value / Constraint |
|---|---:|---|---|---|
| `0..47` | 48 | `0..11` | `ts_ms` | `uint48(uint32(T) * 1000)`; max `0x03E7FFFFFC18` (`< 2^42`, zero overflow even for `T = 0xFFFFFFFF`), always divisible by `1000` |
| `48..51` | 4 | `12` | `version` | `0x8` (`1000` — RFC 9562 UUIDv8) |
| `52..59` | 8 | `13..14` | `sentinel_hi` | `0x6d` (ASCII `'m'` for Mongo/Mako) |
| `60..63` | 4 | `15` | `P0` | High nibble of ObjectId byte 4 (verbatim, zero bit-shifts) |
| `64..65` | 2 | `16 (hi)` | `variant` | `0b10` (RFC 9562 variant) |
| `66..67` | 2 | `16 (lo)` | `sentinel_lo` | `0b10` → hex char 16 is always `'a'` (`0b1010`) |
| `68..127` | 60 | `17..31` | `P1..P15` | Remaining 15 hex chars of ObjectId bytes `4..11` (verbatim) |

Canonical lowercase UUID string:
```text
HHHHHHHH-HHHH-86dP0-aP1P2P3-P4P5P6P7P8P9P10P11P12P13P14P15
```

### 2.2 Formal Proof of Bijectivity, Order Preservation, & Disjointness

- **Image subspace $\mathcal{I} \subset \text{UUID}$**: A UUID (32 lowercase hex chars $s_0\dots s_{31}$) lies in $\mathcal{I}$ iff:
  1. $s_{12..14} = \text{"86d"}$,
  2. $s_{16} = \text{"a"}$,
  3. $H = \text{uint48}(s_{0..11}) \le 4{,}294{,}967{,}295{,}000$ (`0x03e7fffffc18`) and $H \bmod 1000 = 0$.
- **Bijectivity ($|\mathcal{O}| = |\mathcal{I}| = 2^{96}$)**:
  - Left inverse: $f(T, P)$ sets $H = 1000 T \le 1000(2^{32}-1)$ with $H \bmod 1000 = 0$, so $f(T,P) \in \mathcal{I}$; $f^{-1}$ recovers $T = H/1000$ and $(s_{15}, s_{17..31}) = P$.
  - Right inverse: For any $u \in \mathcal{I}$, $1000(H/1000) = H$, fixed nibbles match `86d`/`a`, and payload nibbles match $P$.
- **Strict order preservation**: Multiplication by $1000 > 0$ preserves $T_1 < T_2$, and for $T_1 = T_2$ all fixed bits (`0..59`, `64..67`) match so comparing `(nibble 15, nibbles 17..31)` matches unsigned 64-bit comparison of $P$. Hence:
  $$\forall O_1, O_2 \in \mathcal{O}:\quad O_1 < O_2 \iff \text{objectid\_to\_uuid}(O_1) < \text{objectid\_to\_uuid}(O_2)$$
  This guarantees `ORDER BY updated_at DESC, id DESC` matches MongoDB's `{ updatedAt: -1, _id: -1 }` keyset pagination identically.
- **Chronological B-tree interleaving with future native UUIDv7**: Migrated rows occupy Unix ms `T * 1000` in bits `0..47`, sorting seamlessly alongside future native UUIDv7 rows (`T * 1000 + ms`).
- **0% false positives vs native UUIDv7 / UUIDv4**: Because version is `8` (`!= 7` and `!= 4`), `isObjectIdUuid()` is mathematically disjoint from native UUIDv7/UUIDv4 (unlike a UUIDv7-tagged layout, which has a $\approx 10^{-6}$ collision rate against native UUIDv7s).
- **Verified test vectors** (identical in TS, Zod v4 `z.uuid()`, and Postgres SQL):
  - `000000000000000000000000` ↔ `00000000-0000-86d0-a000-000000000000` (`1970-01-01T00:00:00Z`)
  - `6745f6f4a1b2c3d4e5f60718` ↔ `0193694c-a920-86da-a1b2-c3d4e5f60718` (`2024-11-26T16:27:32Z`)
  - `deadbeefcafebabe01234567` ↔ `0365d6b1-d598-86dc-aafe-babe01234567` (SHA-1 derived)
  - `ffffffffffffffffffffffff` ↔ `03e7ffff-fc18-86df-afff-ffffffffffff` (`2106-02-07T06:28:15Z`)

### 2.3 Wire Format, Dual-Direction Minting, & Non-ObjectId Tables

- **Canonical wire format**: External APIs continue returning lowercase 24-hex ObjectIds via `toWireId(pgUuid)` for all rows in $\mathcal{I}$ (zero breaking changes to frontend, Cloudflare app-router, CLI, SDK, or git repos). Incoming API parameters accept **both** 24-hex ObjectIds and 36-char UUIDs via `parseEntityId(raw)` (fixing Mongoose's `Types.ObjectId.isValid("12-char-str") === true` footgun).
- **Dual-direction creation**: While MongoDB rollback remains active (Stages 2–4), every new record mints its ID once via `newDualId()` (`{ oid, uuid }`) inside $\mathcal{I}$ (or `generate_objectid_uuid()` in SQL), so PG-primary writes reverse-sync cleanly to Mongo with identical `_id`.
- **Non-ObjectId `_id` tables remain `text PRIMARY KEY`**: `users.id`, `sessions.id`, `desktop_auth_codes.id`, `email_verifications.id`, `user_attributions.user_id`, `model_catalog_snapshots.id`.

---

## 3. Complete Collection Classification (`origin/master`)

### Bucket 1 — EXCLUDED: Webhooks, CDC & Sync Engine (Stay in MongoDB)
- `webhookevents`, `cdc_change_events`, `cdc_entity_state`, `cdc_state_transitions`, `cdc_table_write_leases`, `cdc_counters` (raw), `backfill_tmp_*` / `poll_tmp_*` (raw), `flows`, `flow_executions`, `flow_execution_locks` (raw), `flow_data_diffs`, `connector_boxes`, `connector_box_templates`, `connector_box_starts`.
- Cross-plane references (`flows.workspaceId`, `flows.destinationDatabaseId`, etc.) remain 100% consistent with Postgres-hosted workspaces/connections via the bijective 24-hex ObjectId wire format.

### Bucket 2 — EXCLUDED: Already Retired / Dropped (Git Workspace)
- Dropped from MongoDB on `origin/master`: `skills` (`skills_retired_20260904`), `dbt_files`, `dbt_file_drafts`, `dbt_checkouts`, `dashboards`, `dashboardfolders`, `makoapps`, `v1_artifact_purge_backlog`, `materialization_runs`, `cdc_locks`, `cdc_checkpoints`.

### Bucket 3 — Phase 1: Workspaces & Users (Global Rollout)
- **Domain `auth`**: `users`, `user_attributions`, `oauthaccounts` → `oauth_accounts`, `sessions`, `emailverifications` → `email_verifications`, `desktopauthcodes` → `desktop_auth_codes`.
- **Domain `workspaces_core`**: `workspaces`, `Workspace.apiKeys[]` → normalized `workspace_api_keys` (preserving `apiKey._id` for `query_executions.api_key_id`), `workspacemembers` → `workspace_members`, `workspaceinvites` → `workspace_invites`, `workspace_user_handles`, `mcpoauthclients` → `mcp_oauth_clients`, `mcpoauthcodes` → `mcp_oauth_codes`, `mcpoauthtokens` → `mcp_oauth_tokens`, `acpplangrants` → `acp_plan_grants`.

### Bucket 4 — Phase 2: Charts (Console `chartSpec`), Workspace Metadata & Usage Stats (Per-Workspace Rollout)
- **Domain `consoles_charts`**: `savedconsoles` (holds Vega-Lite `chartSpec`, `resultsViewMode`, drafts, ACLs, schedules, `pgvector` 1536-dim `description_embedding` + `tsvector` GIN), `consolefolders`, `entity_versions`, `notebookindexes`, `notebookfolders`, `favourites`.
- **Domain `apps_metadata`**: `app_projects`, `app_index`, `app_index_heads`, `app_embeddings`, `app_lifecycle`, `app_deploy_commit_statuses`, `app_worktrees`, `app_v2_binding_state`, `app_binding_drafts`, `app_binding_jobs`.
- **Domain `usage_stats`**: `app_usage_daily`, `app_usage_events`, `app_feed_snapshots` (24h ephemeral — dual-write only, no backfill), `skill_usage_daily`, `llmusages` (nullable indexed `chat_id uuid`, FK attached after Phase 3 with `ON DELETE SET NULL`), `query_executions`, `connection_verifications`.

### Bucket 5 — Phase 3: Chat (Per-Workspace Rollout)
Synthesized from RealAdvisor/Aura (`crm-chat-api`) and Vercel AI SDK (`Message_v2`):
- **Domain `chat`**:
  - `chats`: envelope + denormalized cumulative `usage_*` counters + `source` (`chat | app | workflow`) + `active_stream_id` / `active_stream_alive_at` (Aura heartbeat) + `turn_checkpoint` JSONB + `local_acp` JSONB. Indexed on `(workspace_id, created_by, updated_at DESC, id DESC) WHERE source = 'chat'` for exact keyset pagination parity.
  - `chat_messages`: `(id uuid PK, chat_id uuid FK CASCADE, ordinal int, client_message_id text, role text, parts jsonb, metadata jsonb, UNIQUE (chat_id, ordinal))` — supports AI SDK v7 `parts[]` verbatim (including Anthropic thinking signatures) and client-pushed Local ACP transcripts (`PUT /:id/messages`).
  - `chat_usage_entries`: per-segment usage history (multi-segment turns may share `assistant_message_index`). Separate from billing ledger `llm_usage`.
  - `chat_attachments`: `id uuid PK` (bijective ObjectId so existing `/api/workspaces/<wid>/chat-images/<aid>` URLs embedded in `parts` keep resolving), `ON DELETE CASCADE` + transactional key return for post-commit blob purge.
  - Resumable streams stay on Redis (`resumable-stream`) in Phase 3a; pure-Postgres `chat_stream_events` (Aura pattern) is an optional Phase 3b follow-up.

### Bucket 6 — Scoping Decisions Needed with User
1. **`databaseconnections`, `connectors` (`SourceConnection`), `connection_access_events`, `connection_write_events`**: Shared by Phase 2 (`savedconsoles`, `query_executions`, app bindings) and Mongo-resident CDC (`flows`). Recommended: migrate in Phase 1b/2a with bijective IDs so `flows` keeps resolving them cleanly; move `DatabaseConnection.connection` Mongoose getter/setter AES encryption into explicit repo-layer `encryptString`/`decryptString`.
2. **`mcp_servers`, `mcp_connection_configs`, `mcp_oauth_flows`, `mcp_tool_grants`**: Backs Phase 3 Chat MCP tool approvals. Recommended: migrate at start of Phase 3 (or late Phase 2).
3. **`github_installations`**: Used by workspace repos, Apps, and dbt. Recommended: fold into Phase 1b (`workspaces_core`) or Phase 2a (`apps_metadata`).
4. **`dbt_projects`, `dbt_env_preferences`, `dbt_jobs`, `dbt_runs`**: Self-contained dbt Cloud replica. Recommended: Phase 2b or dedicated Phase 4.
5. **`scheduled_query_runs`, `notification_rules`, `notification_deliveries`**: `scheduled_query_runs` couples directly to `savedconsoles` (migrate with `consoles_charts`); `notification_*` references both `scheduled_query` and `flow` (migrate in Phase 2b/4).
6. **`workflow_recorded_writes`, `workflow_recorded_runs`, `modelcatalogsnapshots`, `realtime_presence`**: `realtime_presence` (90s TTL) is a natural Redis candidate; the others are small standalone tables for Phase 2/4.
7. **`connectordefinitions`**: Tied to `connectors` & Bucket 1 syncs — keep with Bucket 1 unless `connectors` moves.

---

## 4. Incremental Dual-Run Architecture (Phase 0 Implementation)

### 4.1 Five-Stage Rollout State Machine (`api/src/migration/router.ts`)

State lives in `migration_domain_state` with per-workspace overrides (`workspace_id`) taking precedence over global domain defaults (`scope_key = 'global'`). Cached in-memory for 5s, invalidated across Cloud Run replicas in <1s via Mako's pub/sub service (`mako:migration:state-changed`), and overridden unconditionally by `MIGRATION_FORCE_MONGO_ONLY=true`.

| Stage | Read Path | Primary Write | Secondary Write | Rollback |
|---|---|---|---|---|
| `mongo_only` | Mongo | Mongo | — | Baseline |
| `dual_write_mongo_read` | Mongo | Mongo | PG (1.5s timeout; catch → log + `migration/pg-sync-retry`) | Flip to `mongo_only` (<1s) |
| `dual_write_shadow_compare` | Mongo + sampled async PG diff (semaphore=16) | Mongo | PG (same) | Flip to `dual_write_mongo_read` (<1s) |
| `dual_write_pg_read` | **PG** (+ optional reverse shadow) | **PG** (IDs in $\mathcal{I}$) | Mongo (1.5s timeout; catch → `migration/mongo-sync-retry`) | **Zero-data-loss flip back to `dual_write_mongo_read` (<1s)** |
| `pg_only` | **PG** | **PG** | — | 14–30d frozen Mongo backup |

### 4.2 Backfill, Conflict Safety, Tombstones, & TTL Reaping

- **Backfill (`api/src/migration/backfill.ts`)**: Resumable `_id ASC` cursor persisted in `migration_backfill_jobs`. Started only **after** entering `dual_write_mongo_read`.
  - **Stale overwrite guard**: Mutable tables upsert with `WHERE tbl.updated_at IS NULL OR EXCLUDED.updated_at >= tbl.updated_at`; immutable logs use `ON CONFLICT DO NOTHING`.
  - **Delete-during-backfill guard**: Live deletes record `(table_name, entity_id)` in `migration_tombstones` inside the same PG tx; backfill skips tombstoned IDs.
  - **`$inc` counter rollups**: Live dual-writes increment atomically; backfill processes only closed UTC days (`isClosedUtcDay(day)`), with one reconciliation pass after `00:05 UTC`.
  - **Orphan quarantine**: Corrupt or orphaned legacy Mongo rows (e.g. `ChatAttachment` referencing a deleted `Chat`) are captured in `migration_quarantine` instead of failing the batch.
- **Shadow Compare (`api/src/migration/shadow-compare.ts`)**: Detached from request latency behind a semaphore (`maxInflight = 16`), canonicalizes key order / Dates / null-vs-undefined / float epsilon (`1e-8`), redacts all secrets & message bodies to SHA-256 digests, emits LogTape warnings and OTel counters/histograms.
- **Batch Parity Verifier (`api/src/migration/verifier.ts`)**: Chunked Mongo vs PG existence + SHA-256 parity check with `--repair` healing. Promotion gate to `dual_write_pg_read`: 0 unexplained diffs in batch verifier + 0 shadow mismatches over 24–72h at 100% sampling.
- **TTL Reaper (`api/src/migration/ttl-reaper.ts` + Inngest `migration-pg-ttl-reaper`)**: Hourly bounded `ctid` batch deletes (`LIMIT 5000`, capped batches/run) replacing Mongo's 16 non-CDC TTL indexes, paired with query-time `expires_at > now()` predicates.

---

## 5. Neon Postgres + Drizzle Operations

- **Runtime client (`api/src/database/pg/client.ts`)**: `drizzle-orm` (`^0.44`) + `postgres` (`postgres.js`) over Neon PgBouncer pooled URL (`POSTGRES_URL`, `prepare: false`, `max: 10`, `ssl: "require"`), with automatic `PG_DRIVER=neon-ws` (`@neondatabase/serverless` WebSocket `Pool` over port 443) fallback if Cloud Run's `mako-vpc` egress restricts TCP 5432. Local hosts (`localhost`, `127.0.0.1`, `postgres-platform`) auto-disable SSL.
- **Direct client & migrator (`api/src/database/pg/migrate.ts`)**: Uses `POSTGRES_DIRECT_URL` (`max: 1`) for Drizzle SQL migrations and bulk backfills, guarded by `checkMigrationsFolder()` so missing/empty migration bundles fail loudly.
- **Dev & Preview branching (`scripts/neon-branch.ts`)**: Instant copy-on-write branches via `neonctl` (`create-dev`, `reset-dev`, `resolve-preview`, `delete-preview`, `resolve-integration`, `sync-prod-secret`), plus offline `postgres-platform` (`pgvector/pgvector:pg17` on port `5433`) in `docker-compose.yml`.
- **Testing**: In-process `@electric-sql/pglite` (`runPgliteMigrations` + `setPgTestDb`) for fast unit/contract suites, plus `@testcontainers/postgresql` for full Docker/pgvector integration tests.
