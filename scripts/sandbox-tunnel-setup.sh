#!/usr/bin/env bash
# One-time setup of a STABLE named Cloudflare tunnel for this developer.
#
# Why: the default dev tunnel is an ephemeral `trycloudflare` quick tunnel — a
# random URL that Cloudflare revokes after a while, which churns .env.tunnel and
# poisons the mac/box DNS cache (see scripts/sandbox-tunnel.sh). A NAMED tunnel
# has a permanent hostname: set it up once, and .env.tunnel never changes again.
#
# Run once per machine:  pnpm sandbox:tunnel:setup
# Then `pnpm dev` picks it up automatically (the runner reads APPS_TUNNEL_*
# from .env). Nothing to commit — the credentials and .env entries are local.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"

# Name is per-developer (mirrors the existing close-dev-<user> convention).
# Override the hostname to control the ZONE — it must be a zone your cloudflared
# cert is authorized for (e.g. realadvisor.com), not necessarily mako.ai.
NAME="${1:-apps-dev-$(whoami)}"
HOST="${2:-apps-dev-$(whoami).realadvisor.com}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found — install it (brew install cloudflared)." >&2
  exit 1
fi
if [ ! -f "${HOME}/.cloudflared/cert.pem" ]; then
  echo "Not logged in. Run:  cloudflared tunnel login" >&2
  echo "(pick the zone that owns ${HOST#*.}), then re-run this." >&2
  exit 1
fi

echo "Named tunnel: ${NAME}  →  https://${HOST}"

if ! cloudflared tunnel create "${NAME}" 2>/tmp/mako-cf-create.err; then
  if grep -q "already exists" /tmp/mako-cf-create.err; then
    echo "  tunnel already exists — reusing"
  else
    cat /tmp/mako-cf-create.err >&2
    exit 1
  fi
fi

# Idempotent: routing an existing hostname to the same tunnel is a no-op-ish.
cloudflared tunnel route dns "${NAME}" "${HOST}" || true

# Record in .env (machine-specific — never synced, per the secrets rules).
upsert() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    # macOS sed needs the empty-suffix -i argument.
    sed -i '' "s|^${key}=.*|${key}=${val}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${val}" >>"${ENV_FILE}"
  fi
}
touch "${ENV_FILE}"
upsert APPS_TUNNEL_NAME "${NAME}"
upsert APPS_TUNNEL_HOSTNAME "${HOST}"

echo
echo "Done. .env now points the dev tunnel at the stable hostname:"
echo "  APPS_TUNNEL_NAME=${NAME}"
echo "  APPS_TUNNEL_HOSTNAME=${HOST}"
echo "Restart \`pnpm dev\` (or the sandbox-tunnel process) and it will use it."
