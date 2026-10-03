# Redis editor-data tests

These tests are run from the `server` directory. They cover standalone Redis,
standalone Redis without authentication, Redis Cluster, and Redis Sentinel.

Install dependencies once before running the tests:

```sh
npm ci
npm --prefix Common ci
npm --prefix DocService ci
```

## Important: use a unique prefix

The tests store data in Redis. Always use a new `TEST_REDIS_PREFIX` for each
test invocation. Reusing a prefix can make old keys appear in later tests and
cause failures that look unrelated to the Redis topology.

For example:

```sh
prefix="local:redis:$(date +%s):"
```

The GitHub Actions workflow uses the matrix name, workflow run ID, and run
attempt to provide the same isolation between CI runs.

All commands below write both standard output and standard error to a log file
with `tee`.

## Standalone Redis with a password

Start Redis 8 on port `6379`:

```sh
docker rm -f local-redis 2>/dev/null || true

docker run --name local-redis --network host -d redis:8-alpine \
  redis-server --port 6379 --bind 127.0.0.1 \
  --protected-mode no --appendonly no \
  --requirepass redis-editor-data-password
```

Run all standalone Redis tests:

```sh
prefix="local:standalone:$(date +%s):"

TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_PREFIX="$prefix" \
npm run tests -- --runInBand ../tests/redis \
  2>&1 | tee test-results-standalone.log
```

Run the connection-failure integration test separately:

```sh
prefix="local:failure:$(date +%s):"

TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_FAILURE_CONTAINER=local-redis \
TEST_REDIS_PREFIX="$prefix" \
npm run tests -- --runInBand \
  ../tests/redis/editorDataRedis.failure.integration.tests.js \
  2>&1 | tee test-results-failure.log
```

The failure test intentionally stops and restarts the configured container.
Do not start it with `--rm`, because the test needs the container to exist
after it has been stopped.

## Standalone Redis without a password

Stop the authenticated instance before using port `6379` again:

```sh
docker rm -f local-redis 2>/dev/null || true

docker run --name local-redis --network host -d redis:8-alpine \
  redis-server --port 6379 --bind 127.0.0.1 \
  --protected-mode no --appendonly no
```

Run all tests with authentication variables explicitly removed:

```sh
prefix="local:no-password:$(date +%s):"

env -u TEST_REDIS_NODE_PASSWORD \
    -u TEST_REDIS_SENTINEL_PASSWORD \
    -u TEST_REDIS_NODE_USERNAME \
    -u TEST_REDIS_SENTINEL_USERNAME \
TEST_REDIS_PREFIX="$prefix" \
npm run tests -- --runInBand ../tests/redis \
  2>&1 | tee test-results-no-password.log
```

## Redis Cluster

Remove old nodes before starting a new cluster:

```sh
docker rm -f local-cluster-7000 local-cluster-7001 local-cluster-7002 \
  local-cluster-7003 local-cluster-7004 local-cluster-7005 2>/dev/null || true
```

Start six Redis nodes:

```sh
for port in 7000 7001 7002 7003 7004 7005; do
  docker run --name "local-cluster-$port" --network host -d redis:8-alpine \
    redis-server --port "$port" --bind 127.0.0.1 \
    --protected-mode no --cluster-enabled yes \
    --cluster-config-file "nodes-$port.conf" \
    --cluster-node-timeout 5000 --appendonly no \
    --requirepass redis-editor-data-password \
    --masterauth redis-editor-data-password \
    --cluster-announce-ip 127.0.0.1 \
    --cluster-announce-port "$port" \
    --cluster-announce-bus-port "$((port + 10000))"
done
```

Create the cluster:

```sh
docker exec local-cluster-7000 redis-cli \
  -a redis-editor-data-password \
  --cluster create \
  127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
  127.0.0.1:7003 127.0.0.1:7004 127.0.0.1:7005 \
  --cluster-replicas 1 --cluster-yes
```

Run the regular Cluster tests:

```sh
prefix="local:cluster:$(date +%s):"

TEST_REDIS_CLUSTER=true \
TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_CLUSTER_NODES='redis://127.0.0.1:7000,redis://127.0.0.1:7001,redis://127.0.0.1:7002' \
TEST_REDIS_PREFIX="$prefix" \
npm run tests -- --runInBand \
  --testPathPattern=redis \
  --testPathIgnorePatterns=editorDataRedis.process.tests.js \
  2>&1 | tee test-results-cluster.log
```

Run the independent-process tests:

```sh
TEST_REDIS_CLUSTER=true \
TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_CLUSTER_NODES='redis://127.0.0.1:7000,redis://127.0.0.1:7001,redis://127.0.0.1:7002' \
TEST_REDIS_PREFIX="local:cluster-process:$(date +%s):" \
npm run tests -- --runInBand \
  ../tests/redis/editorDataRedis.process.tests.js \
  2>&1 | tee test-results-cluster-process.log
```

Run Cluster failover and reconnection tests:

```sh
TEST_REDIS_CLUSTER=true \
TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_CLUSTER_NODES='redis://127.0.0.1:7000,redis://127.0.0.1:7001,redis://127.0.0.1:7002' \
TEST_REDIS_TOPOLOGY_REQUIRED=true \
TEST_REDIS_CLUSTER_FAILOVER_REPLICA_PORT=7005 \
TEST_REDIS_CLUSTER_CONTAINER_PREFIX=local-cluster- \
TEST_REDIS_PREFIX="local:cluster-failover:$(date +%s):" \
npm run tests -- --runInBand \
  ../tests/redis/editorDataRedis.topology.tests.js \
  2>&1 | tee test-results-cluster-failover.log
```

## Redis Sentinel

The commands below create an authenticated Sentinel topology with one primary,
one replica, and three Sentinel instances. Remove old containers first:

```sh
docker rm -f local-sentinel-primary local-sentinel-replica \
  local-sentinel-26379 local-sentinel-26380 local-sentinel-26381 \
  2>/dev/null || true
```

Start the primary and replica:

```sh
docker run --name local-sentinel-primary --network host -d redis:8-alpine \
  redis-server --port 6380 --bind 127.0.0.1 \
  --protected-mode no --appendonly no \
  --requirepass redis-editor-data-password

docker run --name local-sentinel-replica --network host -d redis:8-alpine \
  redis-server --port 6381 --bind 127.0.0.1 \
  --protected-mode no --appendonly no \
  --requirepass redis-editor-data-password \
  --masterauth redis-editor-data-password \
  --replicaof 127.0.0.1 6380
```

Start the Sentinel instances:

```sh
for port in 26379 26380 26381; do
  docker run --name "local-sentinel-$port" --network host -d redis:8-alpine \
    sh -c "printf '%s\\n' \
      'port $port' \
      'bind 127.0.0.1' \
      'protected-mode no' \
      'requirepass sentinel-editor-data-password' \
      'sentinel monitor mymaster 127.0.0.1 6380 2' \
      'sentinel auth-pass mymaster redis-editor-data-password' \
      'sentinel down-after-milliseconds mymaster 1000' \
      'sentinel failover-timeout mymaster 5000' \
      'sentinel parallel-syncs mymaster 1' \
      > /tmp/sentinel.conf && \
      exec redis-server /tmp/sentinel.conf --sentinel"
done
```

Run all Sentinel tests:

```sh
prefix="local:sentinel:$(date +%s):"

TEST_REDIS_SENTINEL=true \
TEST_REDIS_SENTINEL_NAME=mymaster \
TEST_REDIS_SENTINEL_NODES='127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381' \
TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_SENTINEL_PASSWORD=sentinel-editor-data-password \
TEST_REDIS_SENTINEL_TRANSIENT_CONTAINER=local-sentinel-26379 \
TEST_REDIS_PREFIX="$prefix" \
npm run tests -- --runInBand ../tests/redis \
  2>&1 | tee test-results-sentinel.log
```

Run Sentinel failover and reconnection tests:

```sh
TEST_REDIS_SENTINEL=true \
TEST_REDIS_SENTINEL_NAME=mymaster \
TEST_REDIS_SENTINEL_NODES='127.0.0.1:26379,127.0.0.1:26380,127.0.0.1:26381' \
TEST_REDIS_NODE_PASSWORD=redis-editor-data-password \
TEST_REDIS_SENTINEL_PASSWORD=sentinel-editor-data-password \
TEST_REDIS_TOPOLOGY_REQUIRED=true \
TEST_REDIS_SENTINEL_PRIMARY_CONTAINER=local-sentinel-primary \
TEST_REDIS_SENTINEL_REPLICA_PORT=6381 \
TEST_REDIS_SENTINEL_TRANSIENT_CONTAINER=local-sentinel-26379 \
TEST_REDIS_PREFIX="local:sentinel-failover:$(date +%s):" \
npm run tests -- --runInBand \
  ../tests/redis/editorDataRedis.topology.tests.js \
  2>&1 | tee test-results-sentinel-failover.log
```

## Cleanup

The following removes all containers created by the commands above:

```sh
docker rm -f local-redis \
  local-cluster-7000 local-cluster-7001 local-cluster-7002 \
  local-cluster-7003 local-cluster-7004 local-cluster-7005 \
  local-sentinel-primary local-sentinel-replica \
  local-sentinel-26379 local-sentinel-26380 local-sentinel-26381 \
  2>/dev/null || true
```

## Matching the complete GitHub Actions matrix

CI repeats these tests with Redis 7.0.15, Redis 7.2, Redis 8, Valkey 7.2,
and Valkey 8. Sentinel CI also tests password, unauthenticated, and ACL
configurations. The exact matrix and container setup are maintained in
`.github/workflows/redisEditorDataTests.yml`.
