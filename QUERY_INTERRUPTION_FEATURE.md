# Query Interruption Feature

## Overview

This feature adds the ability to interrupt/cancel running queries in the console. When a user executes a query, they can now click a "Stop Query" button to terminate the execution on both the client and server side.

## Implementation Details

### Backend Changes

#### 1. Query Execution Tracker Service (`api/src/services/query-execution-tracker.service.ts`)

- **New service** that tracks all running query executions
- Maintains a map of execution IDs to execution metadata
- Supports cancellation via AbortController
- Tracks BigQuery-specific metadata (job ID, project ID, location) for job cancellation
- Automatically cleans up stale executions (older than 1 hour) every 10 minutes

**Key Methods:**
- `startTracking()` - Begins tracking a new query execution, returns execution ID and AbortController
- `updateBigQueryMetadata()` - Updates BigQuery job information for cancellation
- `stopTracking()` - Removes completed/failed execution from tracking
- `cancelExecution()` - Cancels a running query by execution ID
- `cleanupStaleExecutions()` - Periodic cleanup of old executions

#### 2. Cancel Endpoint (`api/src/routes/workspace-databases.ts`)

- **New endpoint**: `POST /api/workspaces/:workspaceId/execute/cancel`
- Accepts `executionId` in request body
- Verifies workspace access before cancellation
- Returns success/error status

#### 3. Updated Execute Endpoint (`api/src/routes/workspace-databases.ts`)

- Modified `POST /api/workspaces/:workspaceId/execute` endpoint
- Now tracks each execution and returns `executionId` in response
- Passes `AbortSignal` to database connection service
- Automatically stops tracking on completion or error

#### 4. Database Service Updates (`api/src/services/database-connection.service.ts`)

**Updated `QueryExecuteOptions` interface:**
- Added `executionId?: string` - For tracking
- Added `abortSignal?: AbortSignal` - For cancellation

**BigQuery Query Execution:**
- Checks abort signal before starting query
- Updates tracker with BigQuery job metadata (job ID, project ID, location)
- Polls for cancellation during job completion wait
- Cancels BigQuery job via API when abort signal is triggered
- Checks for cancellation during result pagination

**PostgreSQL Query Execution:**
- Checks abort signal before starting query
- Sets up abort handler that uses `pg_cancel_backend()` to terminate query
- Properly cleans up event listeners
- Handles both temporary and cached connections

**Other Database Types:**
- Basic abort signal checking added
- Can be extended with database-specific cancellation logic

### Frontend Changes

#### 1. Console Component (`app/src/components/Console.tsx`)

**Updated Props:**
- Added `onCancel?: () => void` callback for cancellation

**UI Changes:**
- Replaced single "Run" button with conditional rendering:
  - Shows "Run (⌘/Ctrl+Enter)" button when not executing
  - Shows "Stop Query" button (red, with stop icon) when executing
- Stop button calls `onCancel` callback when clicked

#### 2. Editor Component (`app/src/components/Editor.tsx`)

**State Management:**
- Added `currentExecutionId` state to track active query execution
- Stores execution ID from query response

**New Handler:**
- `handleConsoleCancel()` - Calls cancel endpoint with current execution ID
- Shows success/error messages via snackbar/modal

**Updated Execute Handler:**
- Stores execution ID from response
- Clears execution ID on completion/error

**Console Integration:**
- Passes `onCancel={handleConsoleCancel}` to Console component

#### 3. Console Store (`app/src/store/consoleStore.ts`)

**Updated `executeQuery()` return type:**
- Now includes `executionId?: string` in response
- Passes execution ID back to caller

## How It Works

### Execution Flow

1. User clicks "Run" button in console
2. Frontend calls `executeQuery()` which hits `/api/workspaces/:workspaceId/execute`
3. Backend:
   - Starts tracking execution with unique ID
   - Creates AbortController
   - Passes abort signal to database service
   - Executes query with cancellation support
4. Backend returns results + execution ID to frontend
5. Frontend stores execution ID for potential cancellation

### Cancellation Flow

1. User clicks "Stop Query" button (only visible during execution)
2. Frontend calls `handleConsoleCancel()` with current execution ID
3. Backend receives cancel request at `/api/workspaces/:workspaceId/execute/cancel`
4. Query tracker:
   - Verifies workspace access
   - Triggers AbortController.abort()
   - Removes execution from tracking
5. Database service:
   - **BigQuery**: Cancels job via `POST /projects/{project}/jobs/{jobId}/cancel`
   - **PostgreSQL**: Executes `SELECT pg_cancel_backend(pid)` to terminate query
   - **Other databases**: Abort signal interrupts execution
6. Frontend shows success/error message

## Database-Specific Cancellation

### BigQuery
- Full job cancellation support
- Tracks job ID, project ID, and location
- Cancels via BigQuery REST API
- Handles multi-region job execution
- Checks for cancellation during:
  - Job polling
  - Result pagination

### PostgreSQL
- Uses `pg_cancel_backend()` function
- Gets process ID via `SELECT pg_backend_pid()`
- Works with both temporary and cached connections
- Properly cleans up event listeners

### MongoDB
- Basic abort signal checking
- Can be extended with MongoDB-specific cancellation (e.g., `killOp`)

### Other Databases
- Basic abort signal checking
- Framework in place for database-specific implementations

## Testing

To test the feature:

1. **BigQuery Long-Running Query:**
   ```sql
   SELECT *
   FROM `bigquery-public-data.usa_names.usa_1910_current`
   WHERE state = 'CA'
   ORDER BY number DESC
   LIMIT 1000000
   ```
   - Execute query
   - Click "Stop Query" button
   - Verify job is cancelled in BigQuery console

2. **PostgreSQL Long-Running Query:**
   ```sql
   SELECT pg_sleep(30);
   ```
   - Execute query
   - Click "Stop Query" button
   - Verify query is terminated

3. **MongoDB Long-Running Query:**
   ```javascript
   db.large_collection.find({}).toArray()
   ```
   - Execute on large collection
   - Click "Stop Query" button
   - Verify execution stops

## Future Enhancements

1. **MongoDB killOp Support:**
   - Track operation IDs
   - Use `db.killOp()` for proper cancellation

2. **MySQL Query Cancellation:**
   - Use `KILL QUERY` command
   - Track connection thread IDs

3. **Progress Indicators:**
   - Show query progress percentage
   - Display rows fetched so far

4. **Query History:**
   - Track cancelled queries
   - Show cancellation reason/time

5. **Timeout Configuration:**
   - Allow users to set query timeout limits
   - Auto-cancel queries exceeding timeout

## Files Modified

### Backend
- `api/src/services/query-execution-tracker.service.ts` (NEW)
- `api/src/routes/workspace-databases.ts` (MODIFIED)
- `api/src/services/database-connection.service.ts` (MODIFIED)

### Frontend
- `app/src/components/Console.tsx` (MODIFIED)
- `app/src/components/Editor.tsx` (MODIFIED)
- `app/src/store/consoleStore.ts` (MODIFIED)

## API Changes

### New Endpoint
```
POST /api/workspaces/:workspaceId/execute/cancel
Body: { executionId: string }
Response: { success: boolean, message?: string, error?: string }
```

### Modified Endpoint
```
POST /api/workspaces/:workspaceId/execute
Response: { success: boolean, data?: any, error?: string, executionId?: string }
```

## Notes

- Execution tracking is in-memory (not persisted to database)
- Stale executions are cleaned up automatically
- Cancellation is best-effort (some queries may complete before cancellation)
- BigQuery job cancellation is asynchronous
- PostgreSQL cancellation uses `pg_cancel_backend()` which is immediate
