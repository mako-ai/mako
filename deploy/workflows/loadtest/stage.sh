#!/usr/bin/env bash
# One stage of the load test on a fresh stack (README.md, "Load test").
#   WORKERS=3 PG_CPUS=2 PG_MEMORY=7680m ./stage.sh --runs 200 --step-ms 2000
# The database is on tmpfs: every stage starts from an empty Hatchet.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
docker compose down --remove-orphans >/dev/null 2>&1 || true
rm -f .token.env
docker compose up -d postgres hatchet >/dev/null 2>&1
node run.mjs setup
docker compose up -d --scale "worker=${WORKERS:-1}" mako worker >/dev/null 2>&1
for _ in $(seq 1 60); do
  [[ "$(docker compose logs worker 2>&1 | grep -c 'Worker started')" -ge "${WORKERS:-1}" ]] && break
  sleep 2
done
set -a; . ./.token.env; set +a
node run.mjs run "$@"
