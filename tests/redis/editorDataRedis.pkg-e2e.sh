#!/bin/sh

# This smoke test is run inside a disposable full-stack DocumentServer
# container. It deliberately executes the DocService binary produced by pkg;
# the source tree is not present in the runtime image.

set -eu

DOCSERVICE_BINARY=${1:-}
if [ -z "$DOCSERVICE_BINARY" ]; then
  DOCSERVICE_BINARY=$(find /var/www -type f -path '*/server/DocService/docservice' -print -quit)
fi

if [ -z "$DOCSERVICE_BINARY" ] || [ ! -x "$DOCSERVICE_BINARY" ]; then
  echo "Packaged DocService binary was not found: ${DOCSERVICE_BINARY:-<empty>}" >&2
  exit 1
fi

for command in curl nc redis-cli redis-server supervisorctl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

DOCSERVICE_DIR=$(dirname "$DOCSERVICE_BINARY")
CONFIG_DIR=${NODE_CONFIG_DIR:-/etc/euro-office/documentserver}
RUN_DIR=$(mktemp -d /tmp/editorDataRedis.pkg-smoke.XXXXXX)
DOCSERVICE_LOG="$RUN_DIR/docservice.log"
REDIS_LOG="$RUN_DIR/redis.log"
REDIS_PID_FILE="$RUN_DIR/redis.pid"
DOCSERVICE_PID=
REDIS_PID=
SERVER_PORT=
REDIS_PORT=

find_free_port() {
  port=$1
  last_port=$2
  while [ "$port" -le "$last_port" ]; do
    if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
    port=$((port + 1))
  done
  echo "No free port in ${1}-${2}" >&2
  return 1
}

stop_process() {
  pid=$1
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill "$pid" 2>/dev/null || true
  attempts=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 50 ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

fail_with_log() {
  message=$1
  echo "$message" >&2
  if [ -f "$DOCSERVICE_LOG" ]; then
    echo '--- packaged DocService log ---' >&2
    tail -n 120 "$DOCSERVICE_LOG" >&2 || true
  fi
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  stop_process "$DOCSERVICE_PID"
  if [ -n "$REDIS_PORT" ]; then
    redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  fi
  stop_process "$REDIS_PID"
  rm -rf "$RUN_DIR"
  exit "$status"
}

trap cleanup EXIT
trap 'exit 143' HUP INT TERM

SERVER_PORT=$(find_free_port 18000 18999)
REDIS_PORT=$(find_free_port 16379 17378)

# The image has already proved that its normal DocService can become ready.
# Stop that supervisor-managed instance so this check has one isolated
# DocService process and can use its own dynamically selected HTTP port.
supervisorctl stop docservice >/dev/null 2>&1 || true

redis-server \
  --bind 127.0.0.1 \
  --port "$REDIS_PORT" \
  --save '' \
  --appendonly no \
  --daemonize yes \
  --pidfile "$REDIS_PID_FILE" \
  --logfile "$REDIS_LOG"

if [ -f "$REDIS_PID_FILE" ]; then
  REDIS_PID=$(cat "$REDIS_PID_FILE")
fi

redis_ready=false
for _ in $(seq 1 50); do
  if redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping 2>/dev/null | grep -qx PONG; then
    redis_ready=true
    break
  fi
  sleep 0.1
done
[ "$redis_ready" = true ] || fail_with_log "Standalone Redis did not become ready on port $REDIS_PORT"

export NODE_ENV=production-linux
export NODE_CONFIG_DIR="$CONFIG_DIR"
export HOME="${HOME:-/home/ds}"
export APPLICATION_NAME="${APPLICATION_NAME:-euro-office}"
node_config=$(printf \
  '{"log":{"options":{"categories":{"default":{"level":"DEBUG"}}}},"services":{"CoAuthoring":{"server":{"port":%s,"editorDataStorage":"editorDataRedis","editorStatStorage":"editorDataRedis"},"redis":{"host":"127.0.0.1","port":%s,"prefix":"pkg-smoke:%s:","optionsCluster":{},"optionsSentinel":{}}}}}' \
  "$SERVER_PORT" "$REDIS_PORT" "$$")
export NODE_CONFIG="$node_config"

(
  cd "$DOCSERVICE_DIR"
  exec "$DOCSERVICE_BINARY"
) >"$DOCSERVICE_LOG" 2>&1 &
DOCSERVICE_PID=$!

healthy=false
for _ in $(seq 1 120); do
  if ! kill -0 "$DOCSERVICE_PID" 2>/dev/null; then
    fail_with_log "Packaged DocService exited before becoming ready"
  fi
  if curl -fsS "http://127.0.0.1:${SERVER_PORT}/healthcheck" 2>/dev/null | grep -qx true; then
    healthy=true
    break
  fi
  sleep 1
done
[ "$healthy" = true ] || fail_with_log "Packaged DocService did not pass /healthcheck"

if grep -Eq 'MODULE_NOT_FOUND|Cannot find module' "$DOCSERVICE_LOG"; then
  fail_with_log 'Packaged DocService reported a module resolution failure'
fi

# The Redis adapter logs through the packaged process. Together with the
# Redis-backed healthcheck above, this makes the selected implementation
# observable rather than merely checking that the executable stayed alive.
grep -q '\[editorDataRedis\]' "$DOCSERVICE_LOG" || \
  fail_with_log 'Packaged DocService did not load the editorDataRedis module'

# Keep the process healthy for a short interval, catching delayed startup or
# reconnect failures that a single readiness request would miss.
for _ in 1 2 3; do
  sleep 2
  kill -0 "$DOCSERVICE_PID" 2>/dev/null || fail_with_log 'Packaged DocService exited during verification'
  curl -fsS "http://127.0.0.1:${SERVER_PORT}/healthcheck" 2>/dev/null | grep -qx true || \
    fail_with_log 'Packaged DocService failed /healthcheck during verification'
done

echo "Packaged DocService passed editorDataRedis smoke test: $DOCSERVICE_BINARY"
