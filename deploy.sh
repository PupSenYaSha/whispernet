#!/usr/bin/env bash
# One-command deploy for WhisperNet (run on the server host, inside the repo dir, as the deploy user)
#
# -e stops at the first failure, -u stops a typo'd variable from becoming an empty string, and pipefail
# stops a failure inside a pipeline from being read as that pipeline's success. The release workflow uses
# the same three; there is no reason for the deploy path to be the laxer one.
set -euo pipefail
cd "$(dirname "$0")"

# Must not be root.
#
# Not a style preference. Everything below runs with this user's privileges: `git pull`, `npm ci`,
# `vite build`, and writing the log and the pidfile. Run as root and every one of those is a write as root,
# including the log - and the log path is the interesting part, see `LOG` below. As root, the whole point of
# the deploy account is gone, and a server process that should be unprivileged is not. There is no
# bootstrap-in-place case this is meant to break: create the user first, then deploy as it.
if [ "$(id -u)" = "0" ]; then
  echo "refusing to deploy as root" >&2
  echo "run this as the deploy user (git pull, npm ci and the build all need to run unprivileged)" >&2
  exit 1
fi

# 0077 for everything this script creates: the state directory, the log and the pidfile.
#
# The log used to be `/tmp/whispernet.log` created 0644 by the shell's `>` - world-readable, and in a
# world-writable directory under a fixed, guessable name that follows symlinks and truncates. Any local user
# could pre-create it as a link to a file the deploy user can write (`~/.ssh/authorized_keys`, a cron file,
# a config file) and get arbitrary content written there as the deploy user, and could read whatever the
# server logged - which includes request lines and whatever else the app puts in its output. `umask 077`
# fixes the permissions; the private directory below fixes the path. Neither is enough on its own: the
# directory is created 0700 by `mkdir` under this umask, so its contents cannot be listed or read by another
# user even if the name is guessed.
umask 077

# A stable per-user directory for the one thing that has to survive between runs (the pidfile), plus a fresh
# unpredictable name for the one that must not be predictable (the log). The directory is under $HOME rather
# than /tmp because /tmp is the shared world-writable one: it is created 0700 under the umask above, and a
# path a different local user cannot even open is not something a symlink can be pointed through.
STATE_DIR="$HOME/.whispernet"
mkdir -p -m 700 "$STATE_DIR"
PIDFILE="$STATE_DIR/server.pid"
LOG="$(mktemp "$STATE_DIR/server-XXXXXXXX.log")"

# must be exported: npm start reads PORT from the environment, so a plain shell variable left the
# server on the default port while this script health-checked a different one and reported FAIL
export PORT="${PORT:-50025}"
# The client is built on the target, which needs the devDependencies. `npm ci` omits them under
# NODE_ENV=production or npm_config_omit=dev, and prepare.js would then spend a second full install
# producing the same omission before failing - so the deploy would die at the health check with nothing but
# "server not responding" to go on.
export NODE_ENV=development
export NPM_CONFIG_PRODUCTION=false
unset npm_config_omit NPM_CONFIG_OMIT
# the server sits behind the tunnel, so req.ip is the proxy's address for every caller otherwise
export TRUST_PROXY="${TRUST_PROXY:-1}"
export SITE_PORT="${SITE_PORT:-3000}"

echo "== WhisperNet deploy =="
echo "   log: $LOG"

# BEFORE the pull, and that ordering is the whole point of moving it.
#
# `strip-bom.js` rewrites tracked files in place. It ran after `git pull --ff-only`, so the first deploy
# worked and every deploy after it aborted: the working tree had local modifications, `git pull` refused
# with "Your local changes would be overwritten by merge", and `set -e` killed the script before the build.
# Deploys then stop happening silently - nothing is listening differently, the old server keeps serving, and
# there is no signal at all. Doing the rewrite first means the pull is what it is supposed to be, and any
# conflict it does report is a real one.
echo "== stripping byte order marks =="
# A byte order mark is invisible in an editor and survives until the strictest tool in the chain meets it:
# Gradle has read `build.gradle` as `?apply plugin` and failed at line 1 column 1. CI runs this too, but CI
# is not the deploy path, and a release built from a checkout nobody remembered to clean up is a release
# nobody built.
node scripts/strip-bom.js

git pull --ff-only

echo "== installing =="
npm ci --no-audit --no-fund

# IMPORTANT: build BEFORE killing the running server (a failed build must not leave the app down ->
# that's what caused the 502). npm start builds the client itself, so this only does it early to
# fail fast. It goes through the npm script rather than re-running vite by hand: the script is the
# definition, and a second copy of it in here is a second thing to forget when it changes.
echo "== rebuilding client =="
npm run build:client

echo "== restarting server =="
# The recorded pid, not a pattern match.
#
# `pkill -f "scripts/start.js"` matches every process on the machine whose command line contains that
# string - which is a property of the *arguments*, so anything that happens to mention it goes too, and the
# pidfile only exists for this one process. A stale pidfile from a crashed run is also harmless: kill fails
# on a pid that is gone or reused, and `|| true` keeps that from aborting the deploy.
# The pidfile now holds the pid of `node scripts/start.js` itself, which `start.js` writes on startup via
# WHISPERNET_PIDFILE. That is the process that has to be signalled: `npm start` puts three levels between
# this script and the server, and npm does not forward SIGTERM to its own script, so signalling npm killed
# nothing while the old server kept the port and the health check below passed against it.
if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE")"
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null || true
    # Give it a moment to release the port before the new one tries to take it.
    for _ in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
sleep 1

WHISPERNET_PIDFILE="$PIDFILE" nohup npm start > "$LOG" 2>&1 &
# A short grace period before the check below: the new process has not written the pidfile yet, and asking
# whether the port is answering immediately would race it.
sleep 3

for i in $(seq 1 25); do
  if curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    # The health check has to answer "is the *new* build serving", not "is anything on this port
    # answering". Those are different questions, and only the first one catches a deploy that silently
    # changed nothing - which is what happened while the old process survived the kill and kept the port.
    #
    # So the pidfile is consulted first: if it still names a process that is not alive, the new server never
    # came up and whatever is answering is the old one, no matter how healthy it looks.
    if [ -f "$PIDFILE" ] && ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "FAIL: the new server did not start (see $LOG)"
      tail -n 20 "$LOG" 2>/dev/null || true
      exit 1
    fi
    # `|| true` on the pipeline, and the first match taken explicitly rather than through `head`.
    #
    # `head -1` closes the pipe as soon as it has a line, `grep` takes SIGPIPE and exits 141, and with
    # `pipefail` the assignment's status becomes that of the pipeline - so `set -e` aborted the script at the
    # very last step, *after* the server had already been restarted. The message said FAIL on a deploy that
    # had worked. `|| true` makes the pipeline tolerant and `sed -n 1p` does not close anything early.
    HASH=$(curl -s "http://127.0.0.1:${PORT}/" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | sed -n '1p' || true)
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
echo "log: $LOG"
tail -30 "$LOG"
exit 1
