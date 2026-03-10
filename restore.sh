#!/bin/bash
set -e
source .env

FROM=$PROD_DATABASE_URL
TO=$DATABASE_URL

# Extract the database name from the URI (last path segment before query string)
TO_DB=$(echo "$TO" | sed -E 's|.*\/([^/?]+)(\?.*)?$|\1|')

echo "Restoring from production → $TO_DB ..."
mongosh "$TO" --eval "db.dropDatabase()"

mongodump --uri="$FROM" --gzip --archive | mongorestore --uri="$TO" --gzip --archive \
  --nsInclude="production.*" \
  --nsFrom="production.*" \
  --nsTo="${TO_DB}.*"
echo "Done!"