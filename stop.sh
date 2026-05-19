#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-4873}"
LABEL="local.macstudio.stockmonitor"
SCREEN_NAME="macstudio-stock-monitor"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
screen -S "$SCREEN_NAME" -X quit >/dev/null 2>&1 || true

kill_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  ps -p "$pid" >/dev/null 2>&1 || return 0

  kill "$pid" >/dev/null 2>&1 || true
  for _ in {1..20}; do
    ps -p "$pid" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  kill -9 "$pid" >/dev/null 2>&1 || true
}

kill_pid_file() {
  local file="$1"
  if [ -f "$file" ]; then
    local value
    value="$(cat "$file")"
    if [[ "$value" != screen:* ]]; then
      kill_pid "$value"
    fi
    rm -f "$file"
  fi
}

kill_port_processes() {
  local pids
  pids="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  while IFS= read -r pid; do
    kill_pid "$pid"
  done <<< "$pids"
}

kill_matching_service_processes() {
  local pattern="$PWD/dist/server/server/index.js"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  while IFS= read -r pid; do
    kill_pid "$pid"
  done <<< "$pids"
}

kill_matching_caffeinate_processes() {
  local pattern="caffeinate -ims .*${PWD}/dist/server/server/index.js"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  while IFS= read -r pid; do
    kill_pid "$pid"
  done <<< "$pids"
}

kill_pid_file data/server.pid
kill_pid_file data/launcher.pid
kill_port_processes
kill_matching_service_processes
kill_matching_caffeinate_processes

rm -f data/server.pid data/launcher.pid

echo "Stopped Mac Studio stock monitor."
