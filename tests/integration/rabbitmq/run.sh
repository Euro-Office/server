#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Euro-Office contributors
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
cd "$(dirname "$0")/../../.."

name="eo-rabbitmq-tests-$(node -p 'require("node:crypto").randomUUID()')"
cleanup() {
  docker rm -fv "$name" >/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Disposable broker container; nothing else is started.
docker run -d --name "$name" \
  -p 127.0.0.1::5672 \
  -e RABBITMQ_DEFAULT_USER=test -e RABBITMQ_DEFAULT_PASS=test \
  -e RABBITMQ_DEFAULT_VHOST="$name" \
  --health-cmd='rabbitmq-diagnostics -q check_running' \
  --health-interval=1s --health-timeout=5s --health-retries=60 \
  rabbitmq:3 >/dev/null

ready=false
for ((i = 0; i < 90; i++)); do
  if [[ $(docker inspect -f '{{.State.Health.Status}}' "$name") == healthy ]]; then
    ready=true
    break
  fi
  sleep 1 # Poll an explicit readiness signal, bounded to 90 attempts.
done
if [[ $ready != true ]]; then
  docker logs "$name"
  echo 'Disposable RabbitMQ did not become ready' >&2
  exit 1
fi
port=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "5672/tcp") 0).HostPort}}' "$name")
export EO_RABBITMQ_TEST_URL="amqp://test:test@127.0.0.1:$port/$name"
cd DocService
# Bound even the production connection helper, which retries connection forever.
timeout --signal=TERM --kill-after=5s 90s ../node_modules/.bin/jest \
  integration/rabbitmq --runInBand --inject-globals=false --config=../tests/jest.config.js
