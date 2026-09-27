#!/usr/bin/env bash
# Run fasemash on your own machine: the site and the game server on one port, no cloud.
#
#   scripts/local.sh              # http://localhost:8080
#   PORT=9000 scripts/local.sh
#
# Sign in (no Google locally): open http://localhost:8080/api/dev/login?email=you@local.test&next=/play
# A second player: another browser (or a private window) with a different email.
#
# Everything lives in memory and is gone when you stop it (Ctrl-C). Optional AI features turn on
# when their key files exist in ~/.facemash (one key per file, never committed):
#   gemini.key      agent talks (with jev.key)
#   jev.key         agent talks, outfit suggestions
#   elevenlabs.key  voice onboarding
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-8080}"
KEYS="$HOME/.facemash"
mkdir -p "$KEYS"

command -v go >/dev/null || { echo "Install Go first: brew install go"; exit 1; }
command -v npm >/dev/null || { echo "Install Node first: brew install node"; exit 1; }

echo "== building the site"
(cd client && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npm run build)

env=(TENANT=hackgt13 PUBLIC_URL="http://localhost:$PORT" ADMIN_EMAILS="${ADMIN_EMAILS:-admin@local.test}")
if [ -f "$KEYS/gemini.key" ]; then env+=(GEMINI_API_KEY_FILE="$KEYS/gemini.key"); echo "== Gemini key found"; fi
if [ -f "$KEYS/jev.key" ]; then env+=(JEV_API_KEY_FILE="$KEYS/jev.key"); echo "== jev key found"; fi
if [ -f "$KEYS/elevenlabs.key" ]; then
  env+=(ELEVENLABS_API_KEY_FILE="$KEYS/elevenlabs.key" ELEVENLABS_AGENT_ID="${ELEVENLABS_AGENT_ID:-local}")
  echo "== ElevenLabs key found"
fi

echo
echo "== fasemash on http://localhost:$PORT"
echo "   sign in:   http://localhost:$PORT/api/dev/login?email=you@local.test&next=/play"
echo "   player 2:  the same link in a private window, with another email"
echo "   admin:     sign in as admin@local.test (or set ADMIN_EMAILS), then open /admin"
echo
cd server
exec env "${env[@]}" go run . -addr ":$PORT" -static ../client/dist -dev-login -dev-talk -session-key "$KEYS/session.key"
