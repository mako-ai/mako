#!/usr/bin/env bash
# One visible, logged-in browser that belongs to THIS session only.
#
# agent-browser keeps a machine-wide daemon and, unless told otherwise, every
# caller lands in the session literally named "default". Two Claude Code
# sessions (or a human and an agent) then drive the same browser: one
# navigates while the other screenshots, tabs vanish mid-task, and
# `agent-browser close --all` — which is global, not per-session — kills
# everyone's browser at once.
#
# This script gives the calling session its own named session and its own
# Chrome profile directory, keyed off the Claude session id so it is stable
# across commands within a session and unique between them. Two agents can
# then work side by side without touching each other.
#
#   ./scripts/dev-browser.sh              # isolate + log in + open the app
#   ./scripts/dev-browser.sh --env-only   # just print the exports
#   eval "$(./scripts/dev-browser.sh --env-only)"
#
# After running it, export the two printed variables in any shell that will
# issue further agent-browser commands — passing --profile to some commands and
# not others puts them in DIFFERENT sessions, which looks like the browser
# ignoring your navigation.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_URL="${APP_URL:-http://localhost:5173}"
API_URL="${API_URL:-http://localhost:8080}"

# Stable within one Claude Code session, distinct between sessions. Falls back
# to the terminal's own id so a plain human shell still gets its own lane.
raw_id="${CLAUDE_CODE_BRIDGE_SESSION_ID:-${STARSHIP_SESSION_KEY:-$$}}"
key="$(printf '%s' "$raw_id" | shasum | cut -c1-10)"

AGENT_BROWSER_HEADED=1
AGENT_BROWSER_SESSION="mako-${key}"
AGENT_BROWSER_PROFILE="${HOME}/.agent-browser-profiles/mako-${key}"
export AGENT_BROWSER_HEADED AGENT_BROWSER_SESSION AGENT_BROWSER_PROFILE
mkdir -p "$AGENT_BROWSER_PROFILE"

print_env() {
  echo "export AGENT_BROWSER_HEADED=1"
  echo "export AGENT_BROWSER_SESSION=${AGENT_BROWSER_SESSION}"
  echo "export AGENT_BROWSER_PROFILE=${AGENT_BROWSER_PROFILE}"
}

if [[ "${1:-}" == "--env-only" ]]; then
  print_env
  exit 0
fi

# Sign in without anyone typing a password: DEV_LOGIN_PASSWORD stands in for
# any local user, and is inert off loopback / outside development (see
# api/src/auth/dev-login.ts).
secret="$(grep -E '^DEV_LOGIN_PASSWORD=' "${ROOT}/.env" | cut -d= -f2- || true)"
email="${MAKO_DEV_EMAIL:-$(git -C "$ROOT" config user.email)}"
cookie_jar="$(mktemp)"
trap 'rm -f "$cookie_jar"' EXIT

if [[ -n "$secret" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -c "$cookie_jar" \
    -X POST "${API_URL}/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"${email}\",\"password\":\"${secret}\"}")"
  if [[ "$code" != "200" ]]; then
    echo "warning: dev login for ${email} returned HTTP ${code}; opening signed out" >&2
  fi
else
  echo "warning: DEV_LOGIN_PASSWORD is not set in .env; opening signed out" >&2
  echo "         (pnpm secrets:pull, or see .env.example)" >&2
fi

agent-browser open "$APP_URL" >/dev/null 2>&1 || true

session_cookie="$(awk '/auth_session/ {print $7}' "$cookie_jar" 2>/dev/null || true)"
if [[ -n "$session_cookie" ]]; then
  agent-browser cookies set auth_session "$session_cookie" \
    --url "$APP_URL" --path / >/dev/null
  agent-browser open "$APP_URL" >/dev/null
fi

headless_count="$(ps aux | grep 'agent-browser-chrome' | grep -v grep | grep -c headless || true)"

echo "session : ${AGENT_BROWSER_SESSION}   (isolated; other agents are unaffected)"
echo "profile : ${AGENT_BROWSER_PROFILE}"
echo "url     : $(agent-browser get url 2>/dev/null | tail -1)"
echo "visible : $([[ "$headless_count" == "0" ]] && echo yes || echo "NO — ${headless_count} headless chrome(s) found")"
echo
echo "Reuse this session in later commands with:"
print_env
echo
echo "Close YOUR browser with 'agent-browser close'."
echo "Never 'agent-browser close --all' — that is global and kills other agents' browsers."
