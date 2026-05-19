#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4873}"
NODE_BIN="$(realpath "$(command -v node)")"
SERVER_ENTRY="$PWD/dist/server/server/index.js"
SCREEN_NAME="macstudio-stock-monitor"
CAFFEINATE_BIN="$(command -v caffeinate || true)"

mkdir -p data logs

if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Building project..."
npm run build

is_running() {
  local pid="$1"
  [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1
}

if [ -f data/server.pid ] && is_running "$(cat data/server.pid)"; then
  echo "Already running: http://127.0.0.1:$PORT"
  exit 0
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Run ./restart.sh to replace the current service."
  exit 1
fi

echo "Starting Mac Studio stock monitor in background..."
if [ -n "$CAFFEINATE_BIN" ]; then
  RUNNER=("$CAFFEINATE_BIN" -ims "$NODE_BIN" "$SERVER_ENTRY")
  echo "Sleep prevention: enabled while service is running."
else
  RUNNER=("$NODE_BIN" "$SERVER_ENTRY")
  echo "Sleep prevention: caffeinate not found; service may pause while Mac sleeps."
fi

if command -v screen >/dev/null 2>&1; then
  screen -dmS "$SCREEN_NAME" env NODE_ENV=production HOME="$HOME" PORT="$PORT" "${RUNNER[@]}"
  echo "screen:$SCREEN_NAME" > data/launcher.pid
else
  nohup env NODE_ENV=production HOME="$HOME" PORT="$PORT" "${RUNNER[@]}" >> logs/server.log 2>&1 < /dev/null &
  echo $! > data/launcher.pid
fi

for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
    echo "Started: http://127.0.0.1:$PORT"
    echo "PID: $(cat data/server.pid 2>/dev/null || cat data/launcher.pid)"
    echo "Logs: $PWD/logs/server.log"
    exit 0
  fi
  sleep 1
done

echo "Service did not become ready. Check logs/server.log"
exit 1
