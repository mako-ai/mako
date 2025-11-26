# Console Schema Migration: connectionId and databaseId_new

This document describes the migration steps for updating the console schema to properly distinguish between `connectionId` (DatabaseConnection ObjectId) and `databaseId_new` (sub-database UUID for cluster mode connections like D1).

## Background

Previously, the console schema only had a `databaseId` field that was used for both:
1. The DatabaseConnection ObjectId (the server/connection)
2. The sub-database UUID (for cluster mode connections like D1)

This caused issues when:
- A console was attached to a SQLite/D1 database where both values should be different
- The `read_console` tool returned the same value for both `connectionId` and `databaseId`
- Saving a console didn't preserve the sub-database selection
- The dirty state wasn't triggered when switching databases

## Schema Changes

The `ISavedConsole` schema now includes:
- `databaseId` (legacy): DatabaseConnection ObjectId (kept for backward compatibility)
- `connectionId` (new): DatabaseConnection ObjectId (copy of databaseId for clarity)
- `databaseId_new` (new): Sub-database UUID (string, e.g., D1 database UUID for cluster mode)

## Migration Steps

### Phase 1: Add New Fields (Current State)

The schema has been updated to include `connectionId` and `databaseId_new` fields. The application now:
- Saves both `connectionId` and `databaseId_new` when creating/updating consoles
- Loads both fields when reading consoles
- Falls back to `databaseId` for backward compatibility when `connectionId` is not present

**Status**: ✅ Completed - The application is now writing to both old and new fields.

### Phase 2: Backfill Existing Data

Run this migration script to populate `connectionId` for existing consoles:

```javascript
// Migration script: backfill-connectionId.js
// Run this in MongoDB shell or via a migration script

db.savedconsoles.updateMany(
  {
    // Find consoles that have databaseId but no connectionId
    databaseId: { $exists: true, $ne: null },
    $or: [
      { connectionId: { $exists: false } },
      { connectionId: null }
    ]
  },
  [
    {
      $set: {
        // Copy databaseId to connectionId
        connectionId: "$databaseId"
      }
    }
  ]
);

// Verify the migration
db.savedconsoles.find({
  databaseId: { $exists: true, $ne: null },
  connectionId: { $exists: false }
}).count();
// Should return 0
```

**When to run**: After all application deployments are updated (Phase 1 is complete).

### Phase 3: Remove Legacy Field (Future)

Once all deployments are updated and the migration has been verified, you can optionally remove the legacy `databaseId` field:

```javascript
// Migration script: remove-legacy-databaseId.js
// ⚠️ WARNING: Only run this after verifying all deployments are updated
// and you're confident the migration is complete

// First, verify all records have connectionId
const recordsWithoutConnectionId = db.savedconsoles.countDocuments({
  databaseId: { $exists: true, $ne: null },
  connectionId: { $exists: false }
});

if (recordsWithoutConnectionId > 0) {
  print("ERROR: Found records without connectionId. Aborting migration.");
  print("Count: " + recordsWithoutConnectionId);
} else {
  // Remove the databaseId field (connectionId is now the source of truth)
  db.savedconsoles.updateMany(
    {},
    {
      $unset: { databaseId: "" }
    }
  );
  
  // Drop the sparse index on databaseId if it exists
  try {
    db.savedconsoles.dropIndex("databaseId_1");
  } catch (e) {
    // Index might not exist, that's fine
  }
  
  print("Migration complete: Removed legacy databaseId field");
}
```

**When to run**: Only after:
1. All application deployments are updated
2. Phase 2 migration has been run and verified
3. You've confirmed no code paths are still reading from `databaseId` (check logs/monitoring)

## Rollback Plan

If you need to rollback:

1. The `databaseId` field is still present (not removed in Phase 3), so the application can fall back to it
2. Update the application code to use `databaseId` instead of `connectionId`
3. The application will continue to work with the legacy field

## Verification

After each phase, verify:

1. **Phase 1**: New consoles are saving both `connectionId` and `databaseId_new`
   ```javascript
   db.savedconsoles.find({ connectionId: { $exists: true } }).limit(5);
   ```

2. **Phase 2**: All existing consoles have `connectionId` populated
   ```javascript
   db.savedconsoles.countDocuments({
     databaseId: { $exists: true, $ne: null },
     connectionId: { $exists: false }
   });
   // Should be 0
   ```

3. **Phase 3**: Legacy field removed (if you choose to do so)
   ```javascript
   db.savedconsoles.countDocuments({ databaseId: { $exists: true } });
   // Should be 0 (if you removed it)
   ```

## Notes

- The `databaseId` field is kept for backward compatibility and will be populated alongside `connectionId` during Phase 1
- The application code handles both old and new fields gracefully
- No downtime is required for this migration
- The migration can be run incrementally (consoles will work with either old or new fields)
