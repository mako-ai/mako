#!/usr/bin/env bash
# A public URL for this API, so a sandbox can reach its git remote and post
# box-state events. SUPERVISED and self-healing.
#
# The sandbox is an ordinary git clone whose origin is this API. Deployed, that
# needs nothing — BASE_URL is already public. Locally it does: `localhost:8080`
# inside a Firecracker microVM resolves to nothing, so a public tunnel exposes
# this API to the box.
#
# Why a supervisor, not a one-shot: a `trycloudflare` quick tunnel is ephemeral.
# Its URL is random per start, and Cloudflare REVOKES the hostname after a while
# — leaving cloudflared running but its URL NXDOMAIN, every clone/push/event
# failing with "could not resolve host", and nothing noticing. So we watch it:
# verify the URL works END TO END, publish it to .env.tunnel, and respawn with a
# fresh URL the moment it stops answering. The API reads .env.tunnel per-request
# and reconfigures a box's origin when the base changes, so a respawn propagates
# on its own — no restart, no manual step.
#
# Health is checked bypassing the mac's resolver on purpose: mDNSResponder
# negatively caches a revoked *.trycloudflare.com for a long time, so a plain
# curl would report a LIVE tunnel as dead. We resolve via 1.1.1.1 directly and
# curl with --resolve, which tests DNS-revocation AND origin reachability
# without touching the poisoned cache.
#
# Not needed with APPS_V2_SANDBOX_PROVIDER=local, where "the sandbox" is this
# machine and BASE_URL is already correct — so it exits quietly.
set -uo pipefail

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

CF_PID=""
cleanup() {
  [ -n "$CF_PID" ] && kill "$CF_PID" 2>/dev/null || true
  # A file naming a dead tunnel is worse than no file — everything keeps trying
  # to use it. Clear it on the way out.
  : > "$OUT"
}
trap 'cleanup; exit 0' INT TERM
trap 'cleanup' EXIT

# Does the tunnel work end to end? Resolve via 1.1.1.1 (authoritative, ignores
# the mac's poisoned cache), then reach the API THROUGH the tunnel with that IP
# pinned. Empty DNS = revoked; 000/530 = cloudflared can't reach the origin.
healthy() {
  local url="$1" host ip code
  host="${url#https://}"
  ip="$(dig +short "$host" @1.1.1.1 2>/dev/null | grep -E '^[0-9]' | head -1)"
  [ -z "$ip" ] && return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --resolve "${host}:443:${ip}" \
    --max-time 8 "${url}/api/auth/me" 2>/dev/null)"
  case "$code" in 2* | 3* | 4*) return 0 ;; *) return 1 ;; esac
}

while true; do
  log="$(mktemp)"
  cloudflared tunnel --url "http://localhost:${PORT}" >"$log" 2>&1 &
  CF_PID=$!

  url=""
  for _ in $(seq 1 60); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1 || true)"
    [ -n "$url" ] && break
    sleep 1
  done
  if [ -z "$url" ]; then
    echo "sandbox-tunnel: no URL after 60s; respawning (see $log)" >&2
    kill "$CF_PID" 2>/dev/null || true
    sleep 2
    continue
  fi

  # Wait until it actually works before publishing — a box that looks the URL up
  # too early gets NXDOMAIN and its resolver caches the miss.
  ok=""
  for _ in $(seq 1 60); do
    healthy "$url" && {
      ok=1
      break
    }
    sleep 2
  done
  if [ -z "$ok" ]; then
    echo "sandbox-tunnel: ${url} never became healthy in 120s; respawning" >&2
    kill "$CF_PID" 2>/dev/null || true
    sleep 2
    continue
  fi

  printf 'APPS_V2_GIT_ORIGIN_URL=%s\n' "$url" >"$OUT"
  echo "sandbox-tunnel: sandboxes will reach this API at ${url}"

  # Supervise: respawn when it stops answering (revoked hostname, dropped edge
  # connection, or a dead origin). Two strikes so a blip does not churn the URL.
  fails=0
  while kill -0 "$CF_PID" 2>/dev/null; do
    sleep 15
    if healthy "$url"; then
      fails=0
    else
      fails=$((fails + 1))
      echo "sandbox-tunnel: ${url} unhealthy (${fails}/2)" >&2
      [ "$fails" -ge 2 ] && break
    fi
  done

  echo "sandbox-tunnel: tunnel down; respawning with a fresh URL" >&2
  kill "$CF_PID" 2>/dev/null || true
  sleep 2
done
