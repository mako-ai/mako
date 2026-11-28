# RFC: Incremental Migration from MongoDB Atlas to Neon Postgres

- **Status:** Phase 0 Foundation Implemented (`feat/postgres-migration`), Binding Decisions Locked (2026-11-26)
- **Date:** 2026-11-26
- **Scope:** Migrate Mako's platform control plane (Auth, Workspaces & GitHub Installations, Connections, Charts/Consoles & Scheduled Query Runs, Apps Metadata, Usage Stats, MCP, Chat, and dbt/Notifications) from MongoDB Atlas to Neon Postgres without a big-bang cutover. Webhooks, Flows, and the CDC sync engine explicitly stay in MongoDB; `realtime_presence` moves to Redis; resumable chat streams stay on Redis permanently.

---

## 1. Motivation & Constraints

As documented in [`apps.md`](../apps.md) ("End-state platform: Postgres + GitHub, no Mongo"), Mako's long-term control plane is **Neon Postgres** (Drizzle ORM) and its file data plane is **GitHub**. Moving off MongoDB Atlas unlocks:

1. **Relational integrity & eliminating the 16 MB BSON limit**: Chat histories (`chats.messages[]`) previously hit silent BSON document caps, requiring emergency stripping and careful projections. Normalizing `chats` + `chat_messages` + `chat_message_parts` + `chat_message_part_metadata` + `chat_usage_entries` + `chat_attachments` removes that ceiling permanently while preserving byte-exact replay for prompt caching.
2. **Real SQL aggregations & native vector/full-text search**: Replaces Mongo `.aggregate()` pipelines on `llmusages` and `query_executions` with SQL `GROUP BY`, and replaces Atlas `$vectorSearch` / `$text` on `savedconsoles` with `pgvector` HNSW + `tsvector` GIN.
3. **Instant copy-on-write branching**: Replaces slow Mongo Atlas `staging_pr_<N>` preview databases with sub-second Neon branches (`scripts/neon-branch.ts`), plus fast in-process `@electric-sql/pglite` unit/contract tests (`createTestPglite()`) instead of flaky `MongoMemoryServer` launches.
4. **Zero-downtime, incremental cutover**: No single cutover date across domains; every domain supports 5-stage dual-run rollout with <1s zero-data-loss rollback (and per-workspace canarying starting with the RealAdvisor workspace).

### Binding Architectural Constraints & Decisions (2026-11-26)

1. **Clean UUIDv7 user IDs & hashed-token sessions (one-time logout accepted)**:
   - Legacy `users._id` values are mixed strings (15-char Lucia IDs from `generateId(15)` and `randomUUID()` UUIDv4 strings), and legacy `sessions._id` values are raw 64-hex bearer tokens.
   - Rather than carrying legacy text user IDs and raw session tokens into Postgres forever, **`users.id` becomes native `uuid PRIMARY KEY` (RFC 9562 UUIDv7)**, **`users.legacy_id text UNIQUE`** preserves the old Mongo `_id` for backfill and reference rewriting, and **`sessions` start empty in Postgres** using standard SHA-256 hashed tokens (`sessions.token_hash text PRIMARY KEY`).
   - A **one-time logout** at `auth` cutover is explicitly accepted and documented in Section 4.3.
2. **Hard 24-hex ObjectId boundaries (UUIDv8 codec approved)**:
   - Browser client mints `chatId` and `consoleId`/`tabId` client-side (`app/src/utils/objectId.ts`).
   - Cloudflare edge router validates `<appId>.<APPS_DOMAIN>` against `/^[0-9a-f]{24}$/` (`cloudflare/app-router/worker.mjs:113`).
   - CLI (`packages/cli/src/{connection,publish}.js`), App SDK (`packages/app-sdk/vite.js:138`), git manifests (`mako.json`, `consoles/*.sql`, `flows/*.yml`), Mongo-resident `flows`/CDC, and keyset pagination cursors (`api/src/services/chat-list.service.ts`) rely on 24-hex IDs.
   - All ObjectId-backed Postgres tables use the bijective RFC 9562 UUIDv8 codec and continue returning canonical lowercase 24-hex wire IDs over the API.
3. **Arbitrary 96-bit ObjectIds exist**: `derivedAppId()` (`api/src/apps/app-paths.ts:164`) and `derivedConsoleId()` (`api/src/apps/workspace-consoles/definitions.ts:36`) hash SHA-1 prefixes into 24-hex `Types.ObjectId`s, meaning the upper 32 bits can hold **any `uint32` value (`0x00000000..0xFFFFFFFF`)**, not just current Unix timestamps.
4. **Mongo-specific surface is small and clean**: 0 Change Streams, only 4 multi-doc transactions (all in `api/src/services/workspace.service.ts`), 1 `$vectorSearch` (`savedconsoles`), 1 `$text` (`savedconsoles`), and 16 non-CDC TTL collections (replaced by the hourly Inngest `migration-pg-ttl-reaper` + query-time `expires_at > now()` predicates).

---

## 2. ID Strategy: Bijective ObjectId ↔ UUIDv8 Codec & UUIDv7 User IDs

Implemented in `api/src/database/pg/id-codec.ts` and `api/src/database/pg/migrations/0000_objectid_uuid_codec.sql`. **Approved as designed.**

### 2.1 ObjectId ↔ UUIDv8 Bit Layout (RFC 9562 UUIDv8)

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
- **Chronological B-tree interleaving with native UUIDv7**: Migrated rows occupy Unix ms `T * 1000` in bits `0..47`, sorting seamlessly alongside native UUIDv7 rows (`T * 1000 + ms`).
- **0% false positives vs native UUIDv7 / UUIDv4**: Because version is `8` (`!= 7` and `!= 4`), `isObjectIdUuid()` is mathematically disjoint from native UUIDv7/UUIDv4.
- **Verified test vectors** (identical in TS, Zod v4 `z.uuid()`, and Postgres SQL):
  - `000000000000000000000000` ↔ `00000000-0000-86d0-a000-000000000000` (`1970-01-01T00:00:00Z`)
  - `6745f6f4a1b2c3d4e5f60718` ↔ `0193694c-a920-86da-a1b2-c3d4e5f60718` (`2024-11-26T16:27:32Z`)
  - `deadbeefcafebabe01234567` ↔ `0365d6b1-d598-86dc-aafe-babe01234567` (SHA-1 derived)
  - `ffffffffffffffffffffffff` ↔ `03e7ffff-fc18-86df-afff-ffffffffffff` (`2106-02-07T06:28:15Z`)

### 2.3 Wire Format, Dual-Direction Minting, UUIDv7 Users, & Hashed Sessions

- **Canonical 24-hex wire format (ObjectId entities)**: External APIs continue returning lowercase 24-hex ObjectIds via `toWireId(pgUuid)` for all rows in $\mathcal{I}$ (zero breaking changes to frontend, Cloudflare app-router, CLI, SDK, git repos, or Mongo-resident `flows`/CDC). Incoming API parameters accept **both** 24-hex ObjectIds and 36-char UUIDs via `parseEntityId(raw)` (eliminating Mongoose's `Types.ObjectId.isValid("12-char-str") === true` footgun).
- **Dual-direction creation (ObjectId entities)**: While MongoDB rollback remains active (Stages 2–4), every new ObjectId-backed entity mints its ID once via `newDualId()` (`{ oid, uuid }`) inside $\mathcal{I}$ (or `generate_objectid_uuid()` in SQL), so PG-primary writes reverse-sync cleanly to Mongo with identical `_id`.
- **Users (`users.id uuid PRIMARY KEY`, RFC 9562 UUIDv7)**:
  - **New users**: Mint a fresh RFC 9562 UUIDv7 via `generateUuidv7()` (`api/src/database/pg/id-codec.ts`) and write the exact same UUIDv7 to both Postgres (`users.id`, `users.legacy_id = id`) and MongoDB (`users._id = id`).
  - **Legacy users (15-char Lucia IDs & UUIDv4 strings)**: Deterministically map to a valid UUIDv7 via `legacyUserIdToUuidv7(legacyId, createdAt)` (48-bit `createdAt` ms [epoch 0 fallback] + version `7` + 12-bit SHA-256(`legacyId`) + variant `10` + 62-bit SHA-256(`legacyId`)). The original Mongo `_id` is preserved in **`users.legacy_id text UNIQUE`** for backfill idempotency, dual-write resolution, and reference rewriting.
  - **All user foreign keys & actor columns become `uuid`**: `user_id`, `created_by`, `owner_id`, `invited_by`, `saved_by`, `verified_by`, `restored_by` across all migrated tables use native Postgres `uuid` (nullable with `ON DELETE SET NULL` where system/empty actors like `"system"` or `""` exist; `app_usage_daily` / `app_usage_events` explicitly split authenticated `user_id uuid NULL` from `visitor_key text NOT NULL` for `'anon:<hash>'` / `'ph:<id>'`).
  - **Reference-rewriting tool (`pnpm --filter api run pg:rewrite-user-ids`)**: Reads `users.legacy_id -> users.id` from Postgres and idempotently rewrites `user:<legacyId>` principals, ACL `sharedWith[].userId`, `createdBy`/`ownerId`/`userId`/`invitedBy`/`savedBy` fields in Mongo-resident collections (flows, dbt, notifications), and workspace git files (`--dry-run` default, `--apply-mongo`, `--apply-git <dir>`).
- **Sessions (`sessions.token_hash text PRIMARY KEY`, empty start in Postgres)**:
  - Raw random bearer tokens stay **only** in the `auth_session` cookie. Postgres stores **only** `sha256Hex(rawToken)` as `token_hash text PRIMARY KEY` (with `user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE`, `expires_at timestamptz NOT NULL`, `active_workspace_id uuid`, `created_at`, `updated_at`).
  - **Legacy Mongo sessions are NOT backfilled or dual-written to Postgres.** During `mongo_only`, `dual_write_mongo_read`, and `dual_write_shadow_compare`, session CRUD runs against MongoDB with zero raw session tokens ever touching Postgres or Inngest retry payloads. Upon cutting `auth` over to `dual_write_pg_read`, Postgres starts with an empty `sessions` table and all users perform a one-time re-login (see Section 4.3).
- **Remaining non-UUID text PKs**: Only naturally non-UUID key tables remain `text PRIMARY KEY`: `sessions.token_hash`, `desktop_auth_codes.id`, `email_verifications.id`, and `model_catalog_snapshots.id`.

---

## 3. Complete Collection Classification & Phased Placement (`origin/master`)

### Bucket 1 — EXCLUDED: Webhooks, Flows, & CDC Sync Engine (Stay in MongoDB)
- `webhookevents`, `cdc_change_events`, `cdc_entity_state`, `cdc_state_transitions`, `cdc_table_write_leases`, `cdc_counters` (raw), `backfill_tmp_*` / `poll_tmp_*` (raw), `flows`, `flow_executions`, `flow_execution_locks` (raw), `flow_data_diffs`, `connector_boxes`, `connector_box_templates`, `connector_box_starts`.
- Cross-plane references (`flows.workspaceId`, `flows.destinationDatabaseId`, `flows.dataSourceId`, etc.) remain 100% consistent with Postgres-hosted workspaces and connections via the bijective 24-hex ObjectId wire format. User references (`createdBy`, etc.) in Mongo-resident collections are rewritten via `pg:rewrite-user-ids`.

### Bucket 2 — EXCLUDED: Already Retired / Dropped (Git Workspace) or Moved to Redis
- Dropped from MongoDB on `origin/master`: `skills` (`skills_retired_20260904`), `dbt_files`, `dbt_file_drafts`, `dbt_checkouts`, `dashboards`, `dashboardfolders`, `makoapps`, `v1_artifact_purge_backlog`, `materialization_runs`, `cdc_locks`, `cdc_checkpoints`.
- Production realtime presence uses a Redis sorted set per workspace with a 90-second TTL. Redis-less Cloud Run PR previews share presence in their staging Mongo database so previews can run multiple instances.

**Retiring the Mongo presence bridge.** The primary service and `mako-canary` serve separate endpoints and share production Mongo. The canary revision `mako-canary-00001-lgj` runs code that upserts `realtime_presence` on SSE connect and heartbeat, deletes on disconnect, and reads it for stranded chats. [Canary deployment](https://github.com/mako-ai/mako/actions/runs/29111508624) · [Deployed presence code](https://github.com/mako-ai/mako/blob/3bd909afeb47c25fbcd5b0e89f7347e80def7fb4/api/src/services/realtime-presence.service.ts#L26)

1. Run the [bridge release](https://github.com/mako-ai/mako/pull/1570) with its default Mongo compatibility enabled on every serving endpoint, or retire the endpoint. Verify that both services have drained all Mongo-only requests, including existing SSE streams, before allowing Redis-only requests. A Mongo-only revision and a Redis-only revision can each miss the other's attached tabs.
2. Roll out the Redis-only release to each remaining endpoint using the same Redis database. Bridge and Redis-only revisions can read each other's Redis heartbeats. A rollback during this rollout must use the bridge release.
3. After the bridge revisions drain, exercise connect, heartbeat, attached and absent lookups, and disconnect on each serving endpoint. Verify zero application reads and writes on `realtime_presence` in namespace telemetry. Mongo's TTL monitor may still expire old rows. The collection remains on the cleanup denylist.

### Bucket 3 — Phase 1: Auth, Workspaces, GitHub Installations, & Connections
- **Phase 1A — Domain `auth` (Global Rollout)**:
  - `users` (`id uuid PK` UUIDv7, `legacy_id text UNIQUE`, `name text`), `user_attributions` (`user_id uuid PK FK`), `oauth_accounts` (`user_id uuid FK`), `sessions` (`token_hash text PK`, `user_id uuid FK`, starts empty in PG — no backfill), `email_verifications`, `desktop_auth_codes` (`user_id uuid FK`).
  - Ships `pg:rewrite-user-ids` reference-rewriting CLI for Mongo-resident collections and workspace git files.
- **Phase 1B — Domain `workspaces_core` (Global Rollout)**:
  - `workspaces`, normalized `workspace_api_keys` (unpacked from `Workspace.apiKeys[]`, preserving `apiKey._id` for `query_executions.api_key_id`), `workspace_members` (`user_id uuid FK`), `workspace_invites`, `workspace_user_handles`, `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_tokens`, `acp_plan_grants`, plus **`github_installations`** (workspace repos, Apps, and dbt).
  - Deferred post-backfill FK `sessions.active_workspace_id -> workspaces(id) ON DELETE SET NULL` applied after `workspaces_core` backfill completes.
- **Phase 1B / 2A — Domain `connections` (Per-Workspace Rollout)**:
  - **`database_connections`** (`databaseconnections`), **`source_connections`** (`connectors`), **`connection_access_events`**, **`connection_write_events`**, and **`connector_definitions`** (`connectordefinitions`).
  - Uses the bijective ObjectId ↔ UUIDv8 codec so Mongo-resident `flows` and CDC resolve `destinationDatabaseId` / `dataSourceId` seamlessly without any ID rewrite.
  - Replaces `DatabaseConnection.connection` Mongoose AES getter/setter with explicit repository-layer `encryptString` / `decryptString` (matching `SourceConnection.config` field-level encryption).
  - Rewrites `user:<legacyId>` entries inside `writers` / `liveReaders` / `managers` to `user:<uuid>` via `users.legacy_id` resolution and `pg:rewrite-user-ids`.

### Bucket 4 — Phase 2: Charts (`savedconsoles`), Apps Metadata, & Usage Stats (Per-Workspace Rollout)
- **Phase 2A — Domain `consoles_charts`**: `saved_consoles` (holds Vega-Lite `chartSpec`, `resultsViewMode`, drafts, ACLs, schedules, **`pgvector` 1536-dim HNSW `description_embedding` + `tsvector` GIN**), `console_folders`, `entity_versions`, `notebook_indexes`, `notebook_folders`, `favourites`, and **`scheduled_query_runs`**. Hard FK `connection_id -> database_connections(id)` enabled once `connections` lands.
- **Phase 2A/2B — Domain `apps_metadata`**: `app_projects`, `app_index`, `app_index_heads`, `app_embeddings`, `app_lifecycle`, `app_deploy_commit_statuses`, `app_worktrees`, `app_v2_binding_state`, `app_binding_drafts`, `app_binding_jobs`.
- **Phase 2B — Domain `usage_stats`**: `app_usage_daily`, `app_usage_events` (splitting `user_id uuid NULL` + `visitor_key text NOT NULL` for anonymous/PostHog IDs), `app_feed_snapshots` (24h ephemeral — dual-write only, no backfill), `skill_usage_daily`, **`llm_usage`** (`llmusages`, nullable indexed `chat_id uuid`, FK attached after Phase 3 with **`ON DELETE SET NULL`** so billing records outlive deleted chats), `query_executions`, `connection_verifications`.

### Bucket 5 — Phase 3: MCP & Normalized Chat (Per-Workspace Rollout)
- **Phase 3A — Domain `mcp` (Start of Phase 3)**:
  - **`mcp_servers`**, **`mcp_connection_configs`**, **`mcp_oauth_flows`** (10-minute TTL reaped by `migration-pg-ttl-reaper`), **`mcp_tool_grants`** — backs Chat MCP tool discovery and approvals with explicit repo-layer encryption of `oauth.clientInformation`, `headers`, `oauthTokens`, and `codeVerifier`.
- **Phase 3B — Domain `chat` (Normalized Parts Architecture)**:
  - Modeled directly on RealAdvisor/Aura (`mono/crm-chat-api/lib/db/schema.ts` and `crm-chat-api/AGENTS.md` "Same bytes after a new message") and `vercel-labs/ai-sdk-persistence-db` — **explicitly replacing `chat_messages.parts jsonb`**:
    - **`chats`**: envelope + denormalized cumulative `usage_*` counters + `source` (`chat | app | workflow`) + `created_by uuid REFERENCES users(id) ON DELETE SET NULL` (nullable for `"system"` chats) + `active_stream_id` / `active_stream_alive_at` + `turn_checkpoint jsonb` + `local_acp jsonb`. Indexed on `(workspace_id, created_by, updated_at DESC, id DESC) WHERE source = 'chat'` for exact keyset pagination parity.
    - **`chat_messages`**: `(id uuid PK, chat_id uuid FK CASCADE, ordinal int, client_message_id text, role text, metadata jsonb, created_at timestamptz, UNIQUE (chat_id, ordinal))` — message envelope without a monolithic `parts jsonb` blob.
    - **`chat_message_parts`**: one row per part — `id uuid PK`, `message_id uuid NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE`, `type text NOT NULL CHECK (...)`, `order_index integer NOT NULL`, typed columns (`text_value`, `tool_call_id`, `tool_name`, `tool_state`, `tool_input jsonb`, `tool_output jsonb`, `tool_error_text`, `approval_id`, `approval_approved`, `approval_reason`, `file_storage_key`, `file_media_type`, `file_name`, `file_size`, plus lossless preservation of AI SDK v7 / Local ACP fields), `UNIQUE (message_id, order_index)`.
    - **`chat_message_part_metadata`**: 1:1 side table (`part_id uuid PK REFERENCES chat_message_parts(id) ON DELETE CASCADE`, `provider_metadata jsonb`, `call_provider_metadata jsonb`, `result_provider_metadata jsonb`) preserving Anthropic thinking signatures and provider metadata so stored conversation history replays **byte-for-byte** across reloads and prompt caching never breaks.
    - **`chat_usage_entries`**: per-segment usage history (separate from billing ledger `llm_usage`).
    - **`chat_attachments`**: `id uuid PK` (bijective ObjectId so existing `/api/workspaces/<wid>/chat-images/<aid>` URLs embedded in parts keep resolving), `created_by uuid REFERENCES users(id) ON DELETE SET NULL`, `ON DELETE CASCADE` + transactional key return for post-commit blob purge.
  - **Resumable chat streams stay on Redis permanently**: Mako keeps Redis `resumable-stream` permanently. Postgres is **not** used as a stream event transport.

### Bucket 6 — Phase 2B / Phase 4: Remaining Platform Domains
- **Domain `dbt`**: `dbt_projects`, `dbt_env_preferences`, `dbt_jobs`, `dbt_runs`.
- **Domain `notifications`**: `notification_rules`, `notification_deliveries` (references both `scheduled_query` and Mongo-resident `flow` by 24-hex ID).
- **Standalone small tables**: `workflow_recorded_writes`, `workflow_recorded_runs`, `model_catalog_snapshots`.

---

## 4. Incremental Dual-Run Architecture (Phase 0 Implementation)

### 4.1 Five-Stage Rollout State Machine (`api/src/migration/router.ts`)

State lives in `migration_domain_state` with per-workspace overrides (`workspace_id`) taking precedence over global domain defaults (`scope_key = 'global'`). Cached in-memory for 5s, invalidated across Cloud Run replicas in <1s via Mako's pub/sub service (`mako:migration:state-changed`), and overridden unconditionally by `MIGRATION_FORCE_MONGO_ONLY=true`.

| Stage | Read Path | Primary Write | Secondary Write | Rollback |
|---|---|---|---|---|
| `mongo_only` | Mongo | Mongo | — | Baseline |
| `dual_write_mongo_read` | Mongo | Mongo | PG (1.5s timeout; catch → log + `migration/pg-sync-retry`) | Flip to `mongo_only` (<1s) |
| `dual_write_shadow_compare` | Mongo + sampled async PG diff (semaphore=16) | Mongo | PG (same) | Flip to `dual_write_mongo_read` (<1s) |
| `dual_write_pg_read` | **PG** (+ optional reverse shadow) | **PG** (IDs in $\mathcal{I}$ / UUIDv7) | Mongo (1.5s timeout; catch → `migration/mongo-sync-retry`) | **Zero-data-loss flip back to `dual_write_mongo_read` (<1s)** *(see §4.3 for `auth` sessions)* |
| `pg_only` | **PG** | **PG** | — | 14–30d frozen Mongo backup |

### 4.2 Backfill, Conflict Safety, Shadow Soak, & TTL Reaping

- **Backfill (`api/src/migration/backfill.ts`)**: Resumable `_id ASC` cursor persisted in `migration_backfill_jobs`. Started only **after** entering `dual_write_mongo_read`.
  - **Stale overwrite guard**: Mutable tables upsert with `WHERE tbl.updated_at IS NULL OR EXCLUDED.updated_at >= tbl.updated_at`; immutable logs use `ON CONFLICT DO NOTHING`.
  - **Delete-during-backfill guard**: Live deletes record `(table_name, entity_id)` in `migration_tombstones` inside the same PG tx; backfill skips tombstoned IDs.
  - **`$inc` counter rollups**: Live dual-writes increment atomically; backfill processes only closed UTC days (`isClosedUtcDay(day)`), with one reconciliation pass after `00:05 UTC`.
  - **Orphan quarantine**: Corrupt or orphaned legacy Mongo rows (e.g. `ChatAttachment` referencing a deleted `Chat`) are captured in `migration_quarantine` instead of failing the batch.
- **Shadow Compare & 24–72h Promotion Soak (`api/src/migration/shadow-compare.ts`, `verifier.ts`)**:
  - **What the 24–72h promotion soak means in plain language**: Before any domain switches to reading from Postgres (`dual_write_pg_read`), it first runs on **both** databases at once (`dual_write_shadow_compare`) — serving users from MongoDB while reading the same data from Postgres in the background and comparing **every read** (100% sampling) against real production traffic for **24 to 72 hours**. The domain only promotes once the batch parity verifier reports **0 unexplained diffs** and shadow comparison observes **0 mismatches** over the full 24–72h window.
  - **Canary-first rollout**: Every workspace-scoped domain starts with the **RealAdvisor workspace** first before expanding to additional workspaces and finally flipping the global default.
  - **Safety**: Shadow reads run detached from request latency behind a semaphore (`maxInflight = 16`), canonicalize key order / Dates / null-vs-undefined / float epsilon (`1e-8`), redact secrets and message bodies to SHA-256 digests, and emit LogTape warnings + OTel metrics.
- **Expiry via Inngest TTL Reaper (`api/src/inngest/functions/migration/ttl-reaper.ts`)**:
  - Replaces MongoDB's 16 non-CDC TTL indexes with the **hourly Inngest function `migration-pg-ttl-reaper`** (`cron: "0 * * * *"`, `concurrency: { limit: 1 }`), calling `reapAllRegisteredTables()` (`api/src/migration/ttl-reaper.ts`).
  - Deletes expired rows in bounded `ctid` batches (`LIMIT 5000`, capped batches per run) so Neon autovacuum and write locks stay bounded, always paired with query-time `expires_at > now()` predicates so expired records are never served between hourly ticks.

### 4.3 Rollout Sequence & Planned One-Time Logout (`auth` Cutover)

1. Deploy `auth` in `dual_write_mongo_read`, backfill `users`, `user_attributions`, `oauth_accounts`, `email_verifications`, and `desktop_auth_codes` (**skipping `sessions`**), run `pg:verify`, and soak `dual_write_shadow_compare` for 24–72h with 0 mismatches.
2. Run `pg:rewrite-user-ids --dry-run` against production staging/branch clones, verify counts, then schedule the `auth` cutover window.
3. **One-time logout event**: Flip `auth` to `dual_write_pg_read` and run `pg:rewrite-user-ids --apply-mongo` / `--apply-git` for Mongo-resident collections and workspace git files.
   - Because Postgres `sessions` intentionally starts empty with SHA-256 hashed `token_hash` PKs, all existing Mongo `auth_session` cookies are invalidated **once**.
   - Every user signs back in cleanly (OAuth or email code) and receives a fresh session whose raw random token lives only in their cookie and whose SHA-256 hash is stored in Postgres `sessions.token_hash`.
   - Communicate this planned one-time re-login ahead of the `auth` cutover window; all subsequent domain cutovers (`workspaces_core`, `connections`, `consoles_charts`, `apps_metadata`, `usage_stats`, `mcp`, `chat`) are completely transparent with zero additional logouts.
4. Roll out `workspaces_core` + `github_installations` (global), then attach the deferred `sessions.active_workspace_id -> workspaces(id) ON DELETE SET NULL` FK via `pg:migrate -- --post-backfill sessions-active-workspace-fk`.
5. Roll out per-workspace domains (`connections`, `consoles_charts`, `apps_metadata`, `usage_stats`, `mcp`, `chat`, `dbt`, `notifications`), always starting with the **RealAdvisor workspace** first through the 24–72h shadow soak before global promotion.

---

## 5. Neon Postgres + Drizzle Operations (Approved Stack)

- **Runtime client (`api/src/database/pg/client.ts`)**: `drizzle-orm` (`^0.44`) + `postgres` (`postgres.js`) over Neon PgBouncer pooled URL (`POSTGRES_URL`, `prepare: false`, `max: 10`, `ssl: "require"`), with automatic `PG_DRIVER=neon-ws` (`@neondatabase/serverless` WebSocket `Pool` over port 443) fallback if Cloud Run's `mako-vpc` egress restricts TCP 5432. Local hosts (`localhost`, `127.0.0.1`, `[::1]`, `postgres-platform`) auto-disable SSL.
- **Direct client & migrator (`api/src/database/pg/migrate.ts`)**: Uses `POSTGRES_DIRECT_URL` (`max: 1`) for Drizzle SQL migrations and bulk backfills, guarded by `checkMigrationsFolder()` so missing/empty migration bundles fail loudly.
- **Dev & Preview branching (`scripts/neon-branch.ts`)**: Instant copy-on-write branches via `neonctl` (`create-dev`, `reset-dev`, `resolve-preview`, `delete-preview`, `resolve-integration`, `sync-prod-secret`), plus offline `postgres-platform` (`pgvector/pgvector:pg17` on port `5433`) in `docker-compose.yml`.
- **Testing (`api/src/database/pg/test-pglite.ts`)**: In-process `@electric-sql/pglite` constructed via `createTestPglite()` (preloaded with `{ extensions: { vector, pg_trgm } }`) + `runPgliteMigrations` + `setPgTestDb` for fast unit/contract suites, plus `@testcontainers/postgresql` for full Docker/pgvector integration tests.

---

## 6. Operational Limits & Approval Gates

No agent or automated job may perform any of the following without explicit approval from Joan:
- Pushing branches to remote repositories
- Merging migration branches into `master`
- Deploying to staging or production environments
- Executing writes against production databases (Postgres or MongoDB)
- Dropping MongoDB collections or shrinking retention backups
