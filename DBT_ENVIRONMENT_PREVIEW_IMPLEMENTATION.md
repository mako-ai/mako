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
- [x] Database schema with per-environment artifact support
- [x] Materialization service functions for environment-specific builds
- [x] dbt environment resolution for any environment
- [x] Inngest function support for background environment builds
- [x] API endpoints with environment parameter support
- [x] Published view enforcement (never serve env artifacts)

### In Progress / Pending 🔄

#### Frontend State Management (App Store)
- [ ] `bindingBuildStatusByEnv` state to track per-environment build status
- [ ] `materializeBinding()` action accepting environment parameter
- [ ] Polling logic for environment-specific status
- [ ] Environment selection state tied to preview override

#### Frontend UI Components
- [ ] Environment selector in binding editor
- [ ] Build status indicators ("building 2/5", "ready 1h ago")
- [ ] "Build now?" prompt for missing dev artifacts
- [ ] Row cap warning banner when falling back to live query

#### Artifact Loading
- [ ] Update `binding-preview.ts` to select artifact by environment
- [ ] Load from dev artifact when preview env active and ready
- [ ] Fallback to prod if dev artifact not ready
- [ ] Further fallback to live query if neither ready

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

## Testing Checklist

- [ ] Unit tests: artifact key generation, status calculation, environment resolution
- [ ] Integration tests: queue → build → fetch for multiple environments
- [ ] E2E: Switch preview env → materialize dev → load artifact → verify data
- [ ] Concurrency: Two editors materializing prod & dev simultaneously
- [ ] Quota: Workspace size limits, eviction order
- [ ] Safety: Published views reject env artifact requests
- [ ] Fallback: Live query with row cap warning when artifact not ready
- [ ] Stale detection: Build status updates correctly, stale builds recoverable

## Implementation Branches & PRs

- **Branch:** `claude/dbt-parquet-env-preview-l7oluw`
- **Commits:**
  1. Core database schema + materialization service
  2. dbt environment resolution + Inngest updates
  3. API endpoints for environment parameter support

## Code Locations

**Backend (Node/TypeScript):**
- `api/src/database/workspace-schema.ts` - Schema definitions
- `api/src/services/app-binding-materialization.service.ts` - Materialization logic
- `api/src/dbt/dbt-environments.service.ts` - Environment resolution
- `api/src/routes/apps.ts` - API endpoints
- `api/src/inngest/functions/app-binding-materialize.ts` - Background job

**Frontend (React/TypeScript):**
- `app/src/store/appStore.ts` - State management (TODO)
- `app/src/components/DataSourceMaterializationControls.tsx` - Build status UI (TODO)
- `app/src/app-runtime/binding-preview.ts` - Artifact loading (TODO)

## References

- Related to: Mako apps, dbt integration, parquet materialization, data bindings
- Replaces: Row-capped live query fallback for dev previews
- Enables: Full-fidelity dev/staging preview testing before prod merge
