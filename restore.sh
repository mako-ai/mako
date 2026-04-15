#!/bin/bash
set -e
source .env

FROM=$PROD_DATABASE_URL
TO=$DATABASE_URL

# Extract the database name from the URI (last path segment before query string)
TO_DB=$(echo "$TO" | sed -E 's|.*\/([^/?]+)(\?.*)?$|\1|')

FROM_DB=$(echo "$FROM" | sed -E 's|.*\/([^/?]+)(\?.*)?$|\1|')

# Exclude large collections that aren't needed for local development
EXCLUDE_COLLECTIONS=(
  "flow_executions"
  "webhookevents"
  "cdc_change_events"
  "cdc_state_transitions"
  "query_executions"
  "materialization_runs"
  "chats"
  "llmusages"
)
EXCLUDE_ARGS=""
for col in "${EXCLUDE_COLLECTIONS[@]}"; do
  EXCLUDE_ARGS="${EXCLUDE_ARGS} --excludeCollection=${col}"
done

echo "Restoring from production → $TO_DB ..."
echo "Excluding collections: ${EXCLUDE_COLLECTIONS[*]}"
mongosh "$TO" --eval "db.dropDatabase()"

mongodump --uri="$FROM" ${EXCLUDE_ARGS} --gzip --archive | mongorestore --uri="$TO" --gzip --archive \
  --nsInclude="${FROM_DB}.*" \
  --nsFrom="${FROM_DB}.*" \
  --nsTo="${TO_DB}.*"

echo "Creating empty excluded collections with indexes..."
mongosh "$TO" --quiet --eval "
  db.createCollection('flow_executions');
  db.flow_executions.createIndex({ flowId: 1, startedAt: -1 });

  db.createCollection('webhookevents');
  db.webhookevents.createIndex({ flowId: 1, eventId: 1 }, { unique: true });
  db.webhookevents.createIndex({ flowId: 1, status: 1, receivedAt: 1 });
  db.webhookevents.createIndex({ flowId: 1, applyStatus: 1, receivedAt: 1 });
  db.webhookevents.createIndex({ workspaceId: 1, receivedAt: -1 });

  db.createCollection('cdc_change_events');
  db.cdc_change_events.createIndex({ idempotencyKey: 1 }, { unique: true });
  db.cdc_change_events.createIndex({ flowId: 1, entity: 1, ingestSeq: 1 });
  db.cdc_change_events.createIndex({ flowId: 1, entity: 1, recordId: 1, sourceTs: 1, ingestSeq: 1 }, { unique: true });
  db.cdc_change_events.createIndex({ flowId: 1, entity: 1, sourceTs: 1, ingestSeq: 1 });
  db.cdc_change_events.createIndex({ flowId: 1, entity: 1, materializationStatus: 1, ingestSeq: 1 });
  db.cdc_change_events.createIndex({ flowId: 1, entity: 1, stageStatus: 1, ingestSeq: 1 });
  db.cdc_change_events.createIndex({ appliedAt: 1 }, { expireAfterSeconds: 604800 });

  db.createCollection('cdc_state_transitions');
  db.cdc_state_transitions.createIndex({ flowId: 1, at: -1 });

  db.createCollection('query_executions');
  db.query_executions.createIndex({ workspaceId: 1, executedAt: -1 });
  db.query_executions.createIndex({ userId: 1, executedAt: -1 });
  db.query_executions.createIndex({ apiKeyId: 1, executedAt: -1 }, { sparse: true });
  db.query_executions.createIndex({ workspaceId: 1, status: 1 });
  db.query_executions.createIndex({ executedAt: 1 }, { expireAfterSeconds: 7776000 });

  db.createCollection('materialization_runs');
  db.materialization_runs.createIndex({ dashboardId: 1, dataSourceId: 1, requestedAt: -1 });
  db.materialization_runs.createIndex({ workspaceId: 1, requestedAt: -1 });
  db.materialization_runs.createIndex({ status: 1, lastHeartbeat: 1 });
  db.materialization_runs.createIndex({ requestedAt: 1 }, { expireAfterSeconds: 2592000 });

  db.createCollection('chats');
  db.chats.createIndex({ workspaceId: 1 });
  db.chats.createIndex({ workspaceId: 1, title: 1 });
  db.chats.createIndex({ workspaceId: 1, createdBy: 1 });

  db.createCollection('llmusages');
  db.llmusages.createIndex({ workspaceId: 1, createdAt: -1 });
  db.llmusages.createIndex({ userId: 1, createdAt: -1 });
  db.llmusages.createIndex({ chatId: 1 });
  db.llmusages.createIndex({ workspaceId: 1, userId: 1, createdAt: -1 });

  print('Empty collections with indexes created');
"

echo "Done!"