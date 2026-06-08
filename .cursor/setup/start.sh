#!/usr/bin/env bash
# Cursor Cloud `start` phase: one-shot service bootstrap on every machine start.
# Brings up the Docker daemon + a single-node MongoDB replica set, then applies
# migrations. The long-running dev servers run separately in the `dev` terminal.
#
# A replica set is mandatory: workspace creation and other flows use MongoDB
# transactions, which fail on a standalone mongod with
#   "Transaction numbers are only allowed on a replica set member or mongos".
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DOCKER="sudo docker"

# --- 1. Docker daemon (not managed by systemd on the cloud image) ------------
if ! $DOCKER info >/dev/null 2>&1; then
  echo "[start] starting dockerd..."
  sudo dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 30); do
    $DOCKER info >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! $DOCKER info >/dev/null 2>&1; then
  echo "[start] ERROR: Docker daemon is not reachable (see /tmp/dockerd.log)" >&2
  exit 1
fi

# --- 2. MongoDB single-node replica set --------------------------------------
if $DOCKER ps --format '{{.Names}}' | grep -qx mongodb; then
  echo "[start] mongodb container already running"
elif $DOCKER ps -a --format '{{.Names}}' | grep -qx mongodb; then
  echo "[start] starting existing mongodb container"
  $DOCKER start mongodb >/dev/null
else
  echo "[start] creating mongodb container (mongo:7, replSet rs0)"
  $DOCKER run -d -p 27017:27017 --name mongodb mongo:7 --replSet rs0 >/dev/null
fi

echo "[start] waiting for mongod to accept connections..."
for _ in $(seq 1 30); do
  $DOCKER exec mongodb mongosh --quiet --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1 && break
  sleep 1
done

# Initiate the replica set (idempotent: rs.status() throws until initiated).
$DOCKER exec mongodb mongosh --quiet --eval '
  try { rs.status(); }
  catch (e) {
    rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] });
  }
' >/dev/null 2>&1 || true

echo "[start] waiting for replica-set PRIMARY..."
for _ in $(seq 1 30); do
  $DOCKER exec mongodb mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -qx true && break
  sleep 1
done

# --- 3. Migrations -----------------------------------------------------------
# One migration (add_entity_versions_collection) can fail on a brand-new DB;
# core auth/workspace flows still work, so a failure here must not block boot.
echo "[start] applying migrations..."
pnpm migrate || echo "[start] WARN: some migrations failed (expected on a fresh DB) - continuing"

echo "[start] services ready - MongoDB on localhost:27017 (rs0). Dev servers start in the 'dev' terminal."
