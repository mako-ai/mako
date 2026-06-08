#!/usr/bin/env bash
# Cursor Cloud `install` phase: cached + idempotent dependency setup.
# Runs once when the snapshot is built (and is re-cached). Must NOT depend on
# any running services (MongoDB/Docker are brought up later in start.sh).
set -euo pipefail

# Resolve repo root regardless of where this is invoked from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# --- 1. .env bootstrap -------------------------------------------------------
# Only create .env if absent so we never clobber a configured one. Real secrets
# are generated for the two values that block boot; AI_GATEWAY_API_KEY stays a
# placeholder (server boots; AI calls fail until a real key is set).
set_env() {
  local key="$1" val="$2" tmp
  if grep -q "^${key}=" .env; then
    tmp="$(mktemp)"
    sed "s|^${key}=.*|${key}=${val}|" .env >"$tmp" && mv "$tmp" .env
  else
    printf '%s=%s\n' "$key" "$val" >>.env
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  set_env DATABASE_URL "mongodb://localhost:27017/myapp"
  set_env ENCRYPTION_KEY "$(openssl rand -hex 32)"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env NODE_ENV "development"
  echo "[install] created .env from .env.example (generated ENCRYPTION_KEY + SESSION_SECRET)"
else
  echo "[install] .env already present - leaving untouched"
fi

# --- 2. dependencies ---------------------------------------------------------
# Built scripts (ssh2) are approved declaratively via pnpm-workspace.yaml
# (onlyBuiltDependencies); bcrypt is intentionally ignored there. No interactive
# `pnpm approve-builds` step is needed.
echo "[install] installing workspace dependencies..."
pnpm install --frozen-lockfile || pnpm install

echo "[install] done."
