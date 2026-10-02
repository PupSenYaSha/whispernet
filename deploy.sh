#!/usr/bin/env bash
# One-command deploy for WhisperNet (run on the server host, inside the repo dir)
set -e
cd "$(dirname "$0")"

# must be exported: npm start reads PORT from the environment, so a plain shell variable left the
# server on the default port while this script health-checked a different one and reported FAIL
export PORT="${PORT:-50025}"
# the server sits behind the tunnel, so req.ip is the proxy's address for every caller otherwise
export TRUST_PROXY="${TRUST_PROXY:-1}"
export SITE_PORT="${SITE_PORT:-3000}"

echo "== WhisperNet deploy =="

git pull --ff-only

echo "== installing =="
npm ci --no-audit --no-fund

# IMPORTANT: build BEFORE killing the running server (a failed build must not leave the app down ->
# that's what caused the 502). npm start builds the client itself, so this only does it early to
# fail fast.
echo "== rebuilding client =="
node node_modules/vite/bin/vite.js build

echo "== restarting server =="
pkill -f "scripts/start.js" 2>/dev/null || true
pkill -f "server/index.ts" 2>/dev/null || true
sleep 1

nohup npm start > /tmp/whispernet.log 2>&1 &
echo "started, pid $! (log: /tmp/whispernet.log)"

for i in $(seq 1 25); do
  if curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    HASH=$(curl -s "http://127.0.0.1:${PORT}/" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
    echo "OK: server up on :${PORT}, serving ${HASH}"
    echo ""
    echo "Reverse proxy in the cloudpub panel should point to:"
    echo "  messenger (app) -> http://127.0.0.1:${PORT}   (domain rightfully-nice-ram.cloudpub.ru)"
    if [ -d site ]; then
      echo "  marketing site  -> http://127.0.0.1:${SITE_PORT}"
    fi
    exit 0
  fi
  sleep 1
done

echo "FAIL: server not responding on :${PORT}"
tail -30 /tmp/whispernet.log
exit 1
