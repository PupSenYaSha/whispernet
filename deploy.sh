#!/usr/bin/env bash
# One-command deploy for WhisperNet (run on the server host, inside the repo dir)
set -e
cd "$(dirname "$0")"

PORT=${PORT:-50025}

echo "== WhisperNet deploy =="

git pull --ff-only

if [ -f package-lock.json ]; then
  npm install --no-audit --no-fund >/dev/null 2>&1 || true
fi

# IMPORTANT: build BEFORE killing the running server (a failed build must not leave the app down ->
# that's what caused the 502). Also use the local vite, NOT `npx vite build` (npx may resolve a newer
# incompatible vite from the network).
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
    exit 0
  fi
  sleep 1
done

echo "FAIL: server not responding on :${PORT}"
tail -30 /tmp/whispernet.log
exit 1