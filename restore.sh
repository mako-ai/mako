#!/bin/bash
set -e
source .env

FROM=$PROD_DATABASE_URL
TO=$DEV_DATABASE_URL

echo "Dropping dev database..."
mongosh "$TO" --eval "db.dropDatabase()"

echo "Dumping from production and restoring to dev..."
mongodump --uri="$FROM" --gzip --archive | mongorestore --uri="$TO" --gzip --archive \
  --nsInclude="production.*" \
  --nsFrom="production.*" \
  --nsTo="dev.*"
echo "Done!"