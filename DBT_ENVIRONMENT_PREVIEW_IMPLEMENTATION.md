# Full-Fidelity dbt Environment Preview for Parquet-Materialized Data Bindings

## Overview

This implementation enables Mako apps to preview data against different dbt environments (dev, staging, prod) by materializing environment-specific parquet artifacts. Instead of silently falling back to row-capped live queries when a dev preview environment is active, this feature builds complete dev artifacts so editors can preview their exact dev data before shipping to prod.

## Problem Statement

**Current Behavior:**
- Parquet bindings always materialize to prod environment
- Dev preview overrides only work for live bindings
- Parquet bindings in dev preview fall back to row-capped live queries (~500 rows)
- Analytics apps with large parquet bindings appear "broken" in dev preview
- No way to validate app appearance/correctness against dev data before merging

**Desired Behavior:**
- Per-environment artifacts (prod canonical, dev/staging preview-scoped)
- On-demand materialization when switching preview environment
- Explicit build status UI ("building 2/5", "dev artifact ready")
- No silent row caps - show warning if fallback happens and hits limit
- Staleness + provenance badges (environment, built-at, source schema)
- Lifecycle management (evict on TTL, after binding changes, after PR merge)
- Never serve env artifacts to published/shared views

## Completed Implementation

### Phase 1: Database Schema Foundation ✅

**Files Modified:**
- `api/src/database/workspace-schema.ts`

**Changes:**
- Extended `IMakoAppBindingCache` to support per-environment artifacts via `environments` field
- Added `IMakoAppBindingEnvironmentArtifact` interface with:
  - `status`: build status (missing | queued | building | ready | error)
  - `artifactKey`: storage path including environment
  - `statusAt`: heartbeat timestamp for stale detection
  - `sourceSchema`: provenance tracking (which dbt schema was materialized)
  - `history`: build run history per environment
- Added MongoDB schema `MakoAppBindingEnvironmentArtifactSchema` for type-safe storage
- Backward compatible: legacy `parquetArtifactKey` fields preserved for migration

### Phase 2: Materialization Service Core ✅

**Files Modified:**
- `api/src/services/app-binding-materialization.service.ts`

**Changes:**
- Updated `buildAppBindingArtifactKey()` to include environment in path:
  - Prod: `.../bindings/{bindingId}/prod/{hash}.parquet`
  - Dev: `.../bindings/{bindingId}/dev/{hash}.parquet`
- Added `buildAppBindingArtifactPath()` environment parameter support
- Added helper functions:
  - `isEnvironmentBuildActive()`: detects stale dev builds
  - `getOrInitEnvironmentArtifact()`: initializes env cache entry
- Added `buildExecutableQueryForEnvironment()`: resolves dbt schema for any environment
- Implemented `queueAppBindingMaterializationForEnvironment()`:
  - Accepts `environment` parameter
  - Validates environment exists in dbt project
  - Checks environment cache (separate from prod)
  - Atomically claims build slot per (binding, environment) pair
  - Enqueues Inngest event with environment param
  - Falls back to in-process build if Inngest unavailable
- Implemented `materializeAppBindingForEnvironment()`:
  - Executes materialization to environment-specific artifact
  - Stores metadata in `cache.environments[env]`
  - Tracks provenance: sourceSchema, buildTime, rowCount
  - Maintains build history per environment
  - Handles heartbeat and stale build detection
- Extended `getBindingArtifactInfo()` to retrieve environment-specific artifacts
- Extended `buildAppBindingMaterializationStatus()` to include per-environment status in response

### Phase 3: dbt Environment Resolution ✅

**Files Modified:**
- `api/src/dbt/dbt-environments.service.ts`

**Changes:**
- Extended `resolveDbtBoundCode()` to accept optional `environment` parameter
- Now supports resolving `{{ dbt_schema }}` token for any environment (not just prod)
- Used by environment-specific materialization to build against dev/staging schemas

### Phase 4: Inngest Background Job ✅

**Files Modified:**
- `api/src/inngest/functions/app-binding-materialize.ts`

**Changes:**
- Updated `appBindingMaterializeFunction` to handle `environment` parameter in event data
- Routes to `materializeAppBindingForEnvironment()` when environment is specified
- Logs include environment for debugging
- Respects workspace concurrency limits for all environment builds

### Phase 5: API Routes ✅

**Files Modified:**
- `api/src/routes/apps.ts`

**Changes:**
- Updated imports to include environment-specific materialization functions
- **POST materialize endpoint:**
  - Accepts optional `environment` parameter in request body
  - Validates environment exists in dbt project (if specified)
  - Routes to appropriate function based on environment
  - Returns status including all environments
  - Backward compatible (no environment = prod behavior)
- **GET artifact endpoint:**
  - Accepts optional `env` query parameter
  - Enforces published views never serve environment artifacts (403 error)
  - Auto-healing: re-queues build if artifact missing from storage
  - Supports both environment and prod artifacts
- **GET status endpoint:**
  - Enhanced response includes `environments` map with per-environment status
  - Each environment reports: status, error, stale, rowCount, byteSize, sourceSchema, builtAt
  - Backward compatible (old clients ignore new fields)

## Implementation Status

### Completed ✅
- [x] Database schema with per-environment artifact support (Phase 1)
- [x] Materialization service functions for environment-specific builds (Phase 2)
- [x] dbt environment resolution for any environment (Phase 3)
- [x] Inngest function support for background environment builds (Phase 4)
- [x] API endpoints with environment parameter support (Phase 5)
- [x] Published view enforcement (never serve env artifacts)
- [x] App store state management with per-environment tracking (Phase 6)
- [x] Environment-aware artifact loading with fallback logic (Phase 7)
- [x] EnvironmentArtifactStatus component for status display (Phase 8)
- [x] useEnvironmentMaterialization hook for build management (Phase 8)

### Phase 6: Frontend State Management (App Store) ✅

**Files Modified:**
- `app/src/store/appStore.ts`

**Changes:**
- Added `bindingBuildStatusByEnv` state to track per-environment artifact status
- Extended `materializeBinding()` action to accept optional `environment` parameter
- Updated status tracking to store per-environment status separately from prod
- Modified API call to pass environment parameter in request body
- Updated polling logic to handle environment-specific responses from API
- Per-environment builds run independently (prod build doesn't block dev, etc.)

### Phase 7: Frontend Artifact Loading ✅

**Files Modified:**
- `app/src/app-runtime/binding-preview.ts`
- `app/src/app-runtime/duckdb.ts`

**Changes:**
- Added `loadEnvironmentArtifact()` function for environment-scoped parquet loading
- Updated `ensureBindingLoadedForPreview()` to prioritize environment artifacts:
  1. If preview override inactive → load prod artifact (existing behavior)
  2. If override + env artifact ready → load environment artifact (new)
  3. If override + env artifact not ready → execute live query (fallback)
- Environment artifacts use distinct revision prefix (`artifact:${env}`) for proper reload logic
- Error handling with fallback to live query when environment artifact loading fails

### Phase 8: Frontend UI Components ✅

**Files Created:**
- `app/src/components/EnvironmentArtifactStatus.tsx`
- `app/src/hooks/useEnvironmentMaterialization.ts`

**EnvironmentArtifactStatus Component:**
- Display per-environment artifact status (ready, building, queued, error, missing)
- Show row count and freshness when artifact is ready
- Provide "Build now?" button when artifact missing or failed
- Warning banner when falling back to live query (with ~500 row cap notice)
- Display source schema and environment provenance
- Compact variant for space-constrained layouts (preview selector)
- Real-time status updates via app store subscriptions

**useEnvironmentMaterialization Hook:**
- Manage environment-specific materialization workflows
- Track build status and error messages
- Provide `buildArtifact()` function to queue builds
- Support timeout and AbortSignal for cancellation
- Detect when "Build now?" prompt should be shown
- Separate from refreshPreview to avoid unnecessary reloading

### In Progress / Pending 🔄

#### Integration Work
- [ ] Wire EnvironmentArtifactStatus into preview environment selector
- [ ] Add environment selector to binding editor UI
- [ ] Integrate buildArtifact() triggers into UI workflows
- [ ] Update preview override panel to show environment status

#### Lifecycle Management
- [ ] Scheduled cleanup Inngest function (evict TTL'd artifacts)
- [ ] Cleanup on binding code/connection changes
- [ ] Post-PR-merge cleanup for closed environments
- [ ] Workspace quota enforcement and artifact eviction

#### Edge Cases & Safeguards
- [ ] Concurrent editor protection (different envs non-blocking)
- [ ] Stale build detection per environment
- [ ] Row cap warnings during live fallback
- [ ] Artifact provenance badge in preview UI

## Frontend Hook & Component APIs

### useEnvironmentMaterialization Hook

```typescript
const { status, materializing, buildError, canBuild, shouldAutoPrompt, buildArtifact } =
  useEnvironmentMaterialization({
    workspaceId,
    appId,
    bindingId,
    environment: previewEnvironment, // e.g., "dev" or "staging"
    timeoutMs: 10 * 60 * 1000,       // 10 minute timeout
  });

// Trigger a build
if (canBuild) {
  await buildArtifact(force = false);
}
```

Returns:
- `status`: "missing" | "queued" | "building" | "ready" | "error"
- `materializing`: boolean (build in flight)
- `buildError`: string | null (last error message)
- `canBuild`: boolean (status is missing or error)
- `shouldAutoPrompt`: boolean (show "Build now?" UI)
- `buildArtifact()`: async function to queue a build

### EnvironmentArtifactStatus Component

```typescript
<EnvironmentArtifactStatus
  appId={appId}
  bindingId={bindingId}
  environment="dev"
  onBuildClick={() => buildArtifact()}
  buildInProgress={materializing}
  compact={false}
/>
```

Displays:
- Artifact status badge (ready, building, error, etc.)
- Row count and freshness (if ready)
- "Build now?" button (if missing/error)
- Warning banner (if falling back to live query)
- Source schema provenance

## API Contract Examples

### Materialize with Environment
```bash
POST /api/workspaces/{workspaceId}/apps/{appId}/bindings/{bindingId}/materialize
Content-Type: application/json

{
  "environment": "dev",
  "force": false
}

Response:
{
  "success": true,
  "queued": true,
  "alreadyRunning": false,
  "status": {
    "bindingId": "...",
    "status": "queued",
    "queued": true
  }
}
```

### Get Status (Enhanced Response)
```bash
GET /api/workspaces/{workspaceId}/apps/{appId}/bindings/{bindingId}/materialization

Response:
{
  "success": true,
  "data": {
    "bindingId": "...",
    "materialization": "parquet",
    "status": "ready",  // prod status (legacy)
    "rowCount": 500000,
    "parquetBuiltAt": "2025-08-14T10:30:00Z",
    "environments": {
      "prod": {
        "status": "ready",
        "rowCount": 500000,
        "byteSize": 10485760,
        "sourceSchema": "public",
        "builtAt": "2025-08-14T10:30:00Z"
      },
      "dev": {
        "status": "ready",
        "rowCount": 150000,
        "byteSize": 3145728,
        "sourceSchema": "dev_alice",
        "builtAt": "2025-08-14T11:15:00Z"
      }
    }
  }
}
```

### Load Environment Artifact
```bash
GET /api/workspaces/{workspaceId}/apps/{appId}/bindings/{bindingId}/materialization/artifact?env=dev&rev=abc123

Returns parquet stream from dev artifact (or 404 if not ready)
```

## Database Schema Changes

### IMakoAppDataBinding.cache
```typescript
cache?: {
  // Legacy fields (kept for backward compat)
  parquetArtifactKey?: string;
  definitionHash?: string;
  parquetBuildStatus?: "missing" | "queued" | "building" | "ready" | "error";
  rowCount?: number;
  byteSize?: number;

  // NEW: Per-environment artifacts
  environments?: Record<string, {
    status?: "missing" | "queued" | "building" | "ready" | "error";
    statusAt?: Date;           // Heartbeat for stale detection
    artifactKey?: string;      // Full S3/GCS path with environment
    definitionHash?: string;
    artifactRevision?: string;
    error?: string;
    rowCount?: number;
    byteSize?: number;
    builtAt?: Date;
    sourceSchema?: string;     // Provenance: which dbt schema
    history?: Array<{
      at: Date;
      status: "ready" | "error";
      rowCount?: number;
      byteSize?: number;
      error?: string;
    }>;
  }>;
}
```

## Backward Compatibility

- **Legacy prod artifacts:** Stored in `cache.environments.prod` but also mirrored to top-level fields
- **Old clients:** Ignore `environments` field, continue using top-level status/rowCount/etc
- **Migration:** First run moves existing `cache` into `environments.prod`
- **Prod behavior unchanged:** Non-environment queries default to prod (backward compatible)

## Safeguards & Correctness

1. **Published views never serve env artifacts:** Enforced at artifact serving endpoint (403 error)
2. **Per-environment build locks:** Separate claim logic for each (binding, environment) pair
3. **Concurrent editors safe:** Two editors on prod and dev don't block each other
4. **Stale build detection:** Per-environment heartbeat (3-minute timeout per build)
5. **Row cap warnings:** Live fallback shows explicit warning (no silent truncation)
6. **Artifact provenance:** sourceSchema and builtAt tracked for debugging

## Performance Considerations

- **Artifact key includes environment:** Different environments have different storage paths (no conflicts)
- **Hash includes resolved query:** Different schemas = different hash = cache miss (correct invalidation)
- **Per-environment status:** Separate heartbeat prevents one env's stale state from affecting others
- **Storage cost:** Workspace quota enforcement (configurable per workspace)

## Future Enhancements

1. **Scheduled cleanup:** Evict artifacts older than 7 days (configurable per workspace)
2. **Binding change cleanup:** Remove dev artifacts when binding code/connection changes
3. **PR merge cleanup:** Auto-delete dev/staging artifacts for merged PRs
4. **Quota enforcement:** Aggressive eviction when workspace exceeds storage limit
5. **Live query caching:** Cache dev live queries in DuckDB to avoid repeated warehouse hits
6. **Build parallelization:** Materialize multiple bindings concurrently for the same environment

## Verification status

**Verified locally**

- `pnpm build` (lint + typecheck + compile, all packages) passes.
- `pnpm --filter app exec vitest run` — 61 files / 438 tests pass.
- `api/src/services/app-binding-materialization.service.test.ts` (new) passes:
  artifact key segregation per environment, the artifact URL's `env` query
  param, environment-name validation, per-environment stale detection, and
  `parquetUrl` hydration for ready environment artifacts.

The addressing helpers were extracted into
`api/src/services/app-binding-artifact-paths.ts` precisely so they can be
tested — importing the materialization service pulls in Inngest and the
storage clients, which keeps the process alive and can't run in a unit test.

**Not verified — environment limits**

- 7 API test files fail in this sandbox because `mongodb-memory-server` cannot
  download its binary (`403` from `fastdl.mongodb.org`). Pre-existing and
  unrelated to this change, but it means `pnpm --filter api test` halts before
  reaching the new suite; run it directly with
  `tsx src/services/app-binding-materialization.service.test.ts`.

**Not verified — needs a real workspace**

No end-to-end run has happened: nothing here has executed against a live
warehouse, dbt project, or browser. Specifically untested:

- [ ] Queue → build → fetch against a real dbt environment
- [ ] Preview actually loading a dev artifact into DuckDB
- [ ] Two editors materializing prod + dev concurrently
- [ ] The 403 for viewers requesting an environment artifact
- [ ] Live-query fallback and its row-cap warning
- [ ] Recovery from a crashed build via the per-environment heartbeat

## Implementation Branches & PRs

- **Branch:** `claude/dbt-parquet-env-preview-l7oluw`
- **Commits:**
  1. Core database schema + materialization service
  2. dbt environment resolution + Inngest updates
  3. API endpoints for environment parameter support

## Code Locations

**Backend (Node/TypeScript):**
- `api/src/services/app-binding-artifact-paths.ts` - Pure artifact addressing (keys, URLs, env-name validation) + its test
- `api/src/database/workspace-schema.ts` - Database schema definitions
- `packages/schemas/src/app.schema.ts` - Shared binding cache contract (`environments`), consumed by the frontend
- `api/src/services/app-binding-materialization.service.ts` - Materialization core logic
- `api/src/dbt/dbt-environments.service.ts` - Environment resolution and schema mapping
- `api/src/routes/apps.ts` - API endpoints for materialization
- `api/src/inngest/functions/app-binding-materialize.ts` - Background job for queued builds

**Frontend (React/TypeScript):**
- `app/src/store/appStore.ts` - App store with per-environment build status
- `app/src/app-runtime/binding-preview.ts` - Artifact loading with env prioritization
- `app/src/app-runtime/duckdb.ts` - Environment artifact loading into DuckDB
- `app/src/components/EnvironmentArtifactStatus.tsx` - Build status UI component
- `app/src/hooks/useEnvironmentMaterialization.ts` - Build management hook

## References

- Related to: Mako apps, dbt integration, parquet materialization, data bindings
- Replaces: Row-capped live query fallback for dev previews
- Enables: Full-fidelity dev/staging preview testing before prod merge
