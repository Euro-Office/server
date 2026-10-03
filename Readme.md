# Server

[![License](https://img.shields.io/badge/License-GNU%20AGPL%20V3-green.svg?style=flat)](https://www.gnu.org/licenses/agpl-3.0.en.html)

The backend server software layer which is a part of [Euro-Office Document Server](https://github.com/Euro-Office/DocumentServer) and is the base for all other components.

## Redis editor-data backend

The complete editor-data test suite covers Redis 7.0.15, Redis 7.2, and Redis
8 in all three tested topologies: standalone, Cluster, and Sentinel. The
bundled Node-Redis client version is 6.2.1.

## Valkey editor-data backend

The complete editor-data test suite covers Valkey 7.2 and Valkey 8 in all
three tested topologies: standalone, Cluster, and Sentinel.

## Operator configuration

### Versions and topology

The used Node-Redis 6.2.1 library officially supports Redis 7.2 and later.
Use Redis 7.2 or later, or Valkey 7.2 or later, for production deployments.
The compatibility matrix also runs against Redis 7.0.15 because that is the
Redis version provided by Ubuntu 24.04; this is compatibility coverage rather
than the official Node-Redis support floor. Redis 7.2, Redis 8, Valkey 7.2,
and Valkey 8 are tested in standalone, Cluster, and Sentinel configurations.

For Cluster deployments, configure all nodes with the same command and data
semantics. For Sentinel deployments, configure one primary, its replicas, and
the Sentinel quorum through `optionsSentinel`.

Sentinel configuration uses the node-redis shape below. Redis-node credentials
belong in `nodeClientOptions`; Sentinel credentials belong in
`sentinelClientOptions`. Omit both credential objects when the corresponding
deployment is unauthenticated. For compatibility with older entrypoints, an
empty password with no username or with the legacy `default` username is
treated as omitted authentication; any other configured username requires a
non-empty password.

```json
{
  "name": "mymaster",
  "sentinelRootNodes": [{"host": "sentinel-1", "port": 26379}],
  "nodeClientOptions": {"username": "default", "password": "redis-secret", "database": 0},
  "sentinelClientOptions": {"username": "default", "password": "sentinel-secret"}
}
```

Initial Sentinel discovery retries transient topology errors three times. The
outer connection attempt is bounded by 15 seconds; commands have a 30-second
adapter timeout and fail before readiness rather than entering an unbounded
offline queue. A deliberate store or process shutdown remains terminal until
the store is recreated.

### Redis command timeout isolation

Node-Redis multiplexes commands on one physical client, but a command that has
already been written cannot be safely removed from its reply queue. The
editor-data connection group therefore serializes application operations on its
physical client. This is deliberately conservative: a timed-out operation
still aborts its physical client, and operations queued behind it reconnect on
the next client generation instead of sharing the half-open socket. The tradeoff
is that editor-data operations sharing this group are not fully parallel: a
slow operation can impose head-of-line blocking on later operations, potentially
until the 30-second command timeout, and Cluster batches do not retain their
usual per-command parallelism on this group. This protects reply ordering and
fail-closed behavior, but is connection-group isolation rather than unrestricted
per-command isolation. Editor-stat, notification, and other Redis-backed groups
remain separate connection groups.

A true per-command isolation design would require multiple physical clients or
a client pool, with routing and cleanup coordinated across standalone, Cluster,
and Sentinel topologies. It would also need explicit handling for transactions,
stale client generations, reconnects, and coordination-sensitive operations.
That is a substantially larger change with more failure modes; the serialized
editor-data lane is therefore retained as the safer correctness boundary.

### Memory and eviction policy

Set the following on every primary and replica:

```text
maxmemory-policy noeviction
```

The backend assigns bounded lifetimes to transient editor data and relies on
Redis/Valkey expiration plus its cleanup passes. Eviction policies such as
`allkeys-lru`, `allkeys-lfu`, or `volatile-ttl` can remove live editor state
before its intended TTL and are not supported. Size the deployment so normal
operation does not exhaust `maxmemory`; `noeviction` may reject writes under
memory pressure, which is safer than silently evicting active locks or state.

### TTL defaults

The defaults are defined under `services.CoAuthoring.expire` in
`Common/config/default.json`. Values below are the editor-data defaults; numeric
values are seconds unless noted otherwise.

| Data                           |         Default lifetime |
| ------------------------------ | -----------------------: |
| Presence                       |              300 seconds |
| Shard connection counters      |              300 seconds |
| Document locks                 |  604800 seconds (7 days) |
| Messages                       | 86400 seconds (24 hours) |
| Force-save state               |  604800 seconds (7 days) |
| Saved status                   |    3600 seconds (1 hour) |
| Monthly unique-user statistics |                     `1y` |

Presence, locks, messages, force-save state, saved status, and shard counters
are refreshed or expired by the backend as they are used. The document and
force-save indexes are sorted sets with timestamp scores; cleanup removes
expired members, so an index key itself can remain present after its members
expire.

Expiration cleanup is processed in batches of 6 members per index shard. The
Redis `POP_EXPIRED` Lua operation is atomic for one shard, so this cap bounds
both the number of sorted-set members it examines and the number it moves into
that shard's lease/claim sets; a large backlog cannot turn one Lua invocation
into an unbounded blocking operation. Each GC pass checks all 16 shards, and
therefore claims at most 96 entries for either expiration queue per pass. The
at-least-once lease is acknowledged only after the document operation
completes. A sustained arrival rate above the resulting aggregate capacity
should be treated as an operational capacity issue rather than addressed by
making the Lua batch unbounded.

### Key schema

The configured `services.CoAuthoring.redis.prefix` is prepended to every key
generated by the backend. It defaults to `ds:`. Use a distinct prefix when
multiple DocumentServer installations share a Redis/Valkey database.

Tenant and document identifiers are encoded with URL-safe Base64. For a tenant
`<tenant>` and document `<document>`, the per-document base is:

```text
<prefix>{editor:<base64url(tenant)>:<base64url(document)>}:
```

The per-document keys are the base followed by `presence:set`,
`presence:hash`, `presence:version`, `savelock`, `lockdocument`, `locks`,
`message`, `saved`, and `forcesave`.

Cross-document editor-data indexes use 16 fixed shards. The shard is the
FNV-1a hash of the UTF-8 JSON pair `[tenant, document]`, reduced modulo 16.
The tenant is always part of the input, including single-tenant deployments.
The document index and force-save timer for one document deliberately share
the same Redis Cluster hash tag:

```text
<prefix>{editor:index:<shard>}:documents
<prefix>{editor:index:<shard>}:forcesavetimer
<prefix>{editor:index:<shard>}:documents:expired:lease
<prefix>{editor:index:<shard>}:documents:expired:claims
<prefix>{editor:index:<shard>}:forcesavetimer:expired:lease
<prefix>{editor:index:<shard>}:forcesavetimer:expired:claims
```

The shard count is a documented implementation constant, not a runtime
setting. Keep it stable because changing it changes the key schema. Redis
Cluster operations never combine keys from different shards in one Lua script
or transaction.

Tenant statistics use the hash tag `{stat:<base64url(tenant)>}`. Their keys
include presence uniqueness (`presence:unique:*`), monthly presence
statistics (`presence:month:*`), editor connection samples
(`editorconnections`), connection shards (`connections:<type>:count` and
`connections:<type>:updated`), and notification locks
(`notification:<base64url(type)>`). The braces are intentional Redis Cluster
hash tags: all keys for one document or one tenant's statistics stay in the
same slot, while cross-document index traffic is distributed over the 16 index
slots.

## Known limitation: replication failover and locks

Redis and Valkey replication failover is not currently lock-safe. If the
primary fails immediately after granting a lock, the promoted replica may not
have received that lock, allowing another client to acquire it. Redis- and
Valkey-backed editor-data deployments should therefore not be described as
fully failover-safe for locks.

Treat this as a deployment risk and a separate production-readiness follow-up.
Sentinel support, command retries, and `WAIT` do not remove this limitation.

## License

Server is released under an GNU AGPL v3.0 license. See the LICENSE file for more information.
