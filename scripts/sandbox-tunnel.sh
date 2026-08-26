#!/usr/bin/env bash
# A public URL for this API, so a sandbox can reach its git remote.
#
# The sandbox is an ordinary git clone whose origin is this API. Deployed that
# needs nothing — BASE_URL is already public. Locally it does: `localhost:8080`
# inside a Firecracker microVM means the microVM, and resolves to nothing, so
# every clone and push from a sandbox fails.
#
# This writes .env.tunnel with APPS_V2_GIT_ORIGIN_URL and keeps the tunnel up.
# `pnpm dev` starts it; the API loads that file if it is there.
#
# Not needed with APPS_V2_SANDBOX_PROVIDER=local, where "the sandbox" is this
# machine and BASE_URL is already correct — so it exits quietly in that case.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/.env.tunnel"
PORT="${WEB_API_PORT:-8080}"

if grep -qE '^APPS_V2_SANDBOX_PROVIDER=local' "${ROOT}/.env" 2>/dev/null; then
  echo "sandbox-tunnel: local sandbox provider — no tunnel needed"
  : > "$OUT"
  exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "sandbox-tunnel: cloudflared not found." >&2
  echo "  Sandboxes will not be able to clone or push (git remote unreachable)." >&2
  echo "  Install it (brew install cloudflared), or set APPS_V2_SANDBOX_PROVIDER=local." >&2
  : > "$OUT"
  exit 0
fi

log="$(mktemp)"
cloudflared tunnel --url "http://localhost:${PORT}" >"$log" 2>&1 &
pid=$!
# Clean up the stale URL on the way out: a file naming a dead tunnel is worse
# than no file, because everything keeps trying to use it.
trap 'kill "$pid" 2>/dev/null || true; : > "$OUT"' EXIT INT TERM

url=""
for _ in $(seq 1 60); do
  url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
  [ -n "$url" ] && break
  sleep 1
done

if [ -z "$url" ]; then
  echo "sandbox-tunnel: no tunnel URL after 60s; see $log" >&2
  : > "$OUT"
  wait "$pid"
  exit 0
fi

# Do not publish the name before it EXISTS. A quick tunnel's hostname takes a
# while to appear in public DNS; a sandbox that looks it up in that window
# gets NXDOMAIN and its resolver caches the miss (Cloudflare's negative TTL
# is long), after which the box cannot reach this API for the life of that
# cache — git pushes fail, box events never arrive. Wait until the big public
# resolvers answer AND the tunnel serves a response, then write the file.
ready=""
hits=0
for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${url}/api/auth/me" 2>/dev/null)" != "000" ]; then
    hits=$((hits + 1))
    # Two answers a second apart: the edge is routing it, not a one-off.
    [ "$hits" -ge 2 ] && { ready=1; break; }
  else
    hits=0
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "sandbox-tunnel: ${url} is not resolvable/answering after 90s; publishing anyway" >&2
fi

printf 'APPS_V2_GIT_ORIGIN_URL=%s\n' "$url" > "$OUT"
echo "sandbox-tunnel: sandboxes will reach this API at ${url}"
wait "$pid"
