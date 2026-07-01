#!/bin/bash
set -e
source .env

# Usage: ./restore.sh [--include-sync]
#   By default, only the two heaviest sync collections (webhookevents ~1.7GB and
#   flow_executions ~700MB) are excluded to keep the restore fast. Everything
#   else — including chats, llmusages, query_executions, and the smaller CDC /
#   materialization collections — is copied.
#   Pass --include-sync (or set INCLUDE_SYNC=true) to also copy the two heavy ones.
#
#   Tip: stop your local `pnpm dev` before running this. A running API (mongoose)
#   recreates indexes under different names while the restore is in flight, which
#   causes benign IndexOptionsConflict warnings (documents still restore fine).
INCLUDE_SYNC="${INCLUDE_SYNC:-false}"
for arg in "$@"; do
  case "$arg" in
    --include-sync) INCLUDE_SYNC=true ;;
    -h|--help) echo "Usage: $0 [--include-sync]"; exit 0 ;;
    *) echo "Unknown argument: $arg"; echo "Usage: $0 [--include-sync]"; exit 1 ;;
  esac
done

FROM=$PROD_DATABASE_URL
TO=$DATABASE_URL

# Extract the database name from the URI (last path segment before query string)
TO_DB=$(echo "$TO" | sed -E 's|.*\/([^/?]+)(\?.*)?$|\1|')
FROM_DB=$(echo "$FROM" | sed -E 's|.*\/([^/?]+)(\?.*)?$|\1|')

# Heavy sync collections excluded by default (large, ephemeral, not needed to
# work on the app locally); included with --include-sync.
SYNC_COLLECTIONS=(
  "webhookevents"
  "flow_executions"
)

EXCLUDE_ARGS=""
if [ "$INCLUDE_SYNC" != "true" ]; then
  for col in "${SYNC_COLLECTIONS[@]}"; do
    EXCLUDE_ARGS="${EXCLUDE_ARGS} --excludeCollection=${col}"
  done
fi

echo "Restoring from production → $TO_DB ..."
if [ "$INCLUDE_SYNC" = "true" ]; then
  echo "Including sync collections (--include-sync): ${SYNC_COLLECTIONS[*]}"
else
  echo "Excluding sync collections (default): ${SYNC_COLLECTIONS[*]}"
  echo "  → pass --include-sync to copy them too."
fi

mongosh "$TO" --eval "db.dropDatabase()"

# Don't let a benign index-name conflict (from a running local API recreating
# indexes mid-restore) abort the whole script — documents still restore fine.
set +o pipefail
set +e
mongodump --uri="$FROM" ${EXCLUDE_ARGS} --gzip --archive | mongorestore --uri="$TO" --gzip --archive \
  --nsInclude="${FROM_DB}.*" \
  --nsFrom="${FROM_DB}.*" \
  --nsTo="${TO_DB}.*"
RESTORE_STATUS=$?
set -e
if [ "$RESTORE_STATUS" -ne 0 ]; then
  echo "⚠️  mongorestore exited ${RESTORE_STATUS} — usually a benign index-name"
  echo "    conflict from a running local API. Documents are restored; continuing."
  echo "    Stop 'pnpm dev' before restoring to avoid this."
fi

# When sync collections were skipped, create them empty with their indexes so the
# app has the expected schema/indexes without the bulky historical data.
if [ "$INCLUDE_SYNC" != "true" ]; then
  echo "Creating empty sync collections with indexes..."
  mongosh "$TO" --quiet --eval "
    function ensureCollection(name){ if(!db.getCollectionNames().includes(name)) db.createCollection(name); }
    function ensureIndex(coll, keys, opts){ try { db.getCollection(coll).createIndex(keys, opts||{}); } catch(e){ print('  (skipped '+coll+' index: '+e.codeName+')'); } }

    ensureCollection('webhookevents');
    ensureIndex('webhookevents', { flowId: 1, eventId: 1 }, { unique: true });
    ensureIndex('webhookevents', { flowId: 1, status: 1, receivedAt: 1 });
    ensureIndex('webhookevents', { flowId: 1, applyStatus: 1, receivedAt: 1 });
    ensureIndex('webhookevents', { workspaceId: 1, receivedAt: -1 });

    ensureCollection('flow_executions');
    ensureIndex('flow_executions', { flowId: 1, startedAt: -1 });

    print('Empty sync collections with indexes created');
  "
fi

echo "Done!"
