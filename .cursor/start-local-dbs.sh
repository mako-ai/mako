#!/usr/bin/env bash
# Idempotent boot helper for Cursor Cloud Agent VMs (no systemd).
# Starts local MongoDB (replica set rs0) + PostgreSQL 16, then reseeds the
# known cloud-agent login if the API package is available.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# --- MongoDB (single-node replica set; required for transactions) ---
if ! pgrep -x mongod >/dev/null 2>&1; then
  sudo mkdir -p /var/log/mongodb /var/lib/mongodb
  sudo chown -R mongodb:mongodb /var/log/mongodb /var/lib/mongodb 2>/dev/null || true
  if [[ -f /etc/mongod.conf ]]; then
    sudo mongod --config /etc/mongod.conf --bind_ip 127.0.0.1 --fork \
      --logpath /var/log/mongodb/mongod.log
  else
    echo "[start-local-dbs] WARN: /etc/mongod.conf missing; skipping MongoDB start" >&2
  fi
fi

if command -v mongosh >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' 2>/dev/null | grep -q 1; then
      break
    fi
    sleep 1
  done
  mongosh --quiet --eval \
    'try{rs.status()}catch(e){rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]})}' \
    >/dev/null 2>&1 || true
fi

# --- PostgreSQL 16 (Chinook demo source) ---
if command -v pg_ctlcluster >/dev/null 2>&1; then
  if ! sudo pg_ctlcluster 16 main status >/dev/null 2>&1; then
    sudo pg_ctlcluster 16 main start || true
  fi
fi

# --- Seed known admin (soft-fail; script exits 0 if Mongo unreachable) ---
if [[ -f "$ROOT/api/src/scripts/seed-dev-admin.ts" ]] && command -v pnpm >/dev/null 2>&1; then
  pnpm --filter api exec tsx src/scripts/seed-dev-admin.ts || true
fi

echo "[start-local-dbs] ready"
