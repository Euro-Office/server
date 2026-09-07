# Redis-backed editorData (save/auth locks + presence)

## Problem

`editorDataMemory.js` is per-process and entirely in-memory: every save
lock, auth lock, and connected-user's presence lives only in the docservice
process that handled the request. On a single-replica deployment that's
fine — there's only one process to be the source of truth. On a
multi-replica deployment (several docservice instances behind a load
balancer) it isn't: each replica has its own private, disconnected view.

Concretely, this means:

- Two co-authors who land on different replicas can both be granted the
  same save lock at the same time. Each replica sees itself as the only
  editor and grants the lock unconditionally.
- A user joining on one replica has no way to see that the same document is
  already open on another replica — presence is derived purely from that
  replica's own live connections.
- A WOPI host asking "is anyone still editing this document" gets an
  answer scoped to whichever replica happens to serve the request, not the
  real cross-replica state.

None of this shows up in local development or in a single-instance
deployment, which is why it's easy to miss.

## Scope

This module replaces the **save/auth locks** and **presence** portions of
`editorDataMemory`'s interface with Redis-backed implementations that are
genuinely shared across replicas. Everything else — block locks, messages,
save-state, force-save, telemetry — still delegates straight through to
`editorDataMemory`, unchanged, and is therefore still single-replica-only.
Extending coverage to those is future work, not something this module
attempts.

## Enabling it

Set, per replica (all replicas in a deployment must point at the same
Redis):

```json
"services": {
  "CoAuthoring": {
    "server": {
      "editorDataStorage": "editorDataRedisLocks"
    },
    "redis": {
      "host": "...",
      "port": 6379
    }
  }
}
```

`editorDataStorage` defaults to `"editorDataMemory"` — this is opt-in, not
a behavior change for deployments that don't set it. `services.CoAuthoring.redis`
already exists as a config block (`canvasservice.js` already reads its
`prefix` for an unrelated purpose); this module reuses the block rather
than introducing a second Redis config surface.

## Architecture

| File | Responsibility |
|---|---|
| `editorDataRedisLocks.js` | Composition root: owns the Redis connection and the `editorDataMemory` delegate, wires the two stores below against them, exposes the same `EditorData` interface the rest of the codebase already expects. |
| `editorDataRedisSaveLock.js` | `lockSave`/`unlockSave`/`lockAuth`/`unlockAuth`, as atomic Lua scripts. |
| `editorDataRedisPresence.js` | `addPresence`/`updatePresence`/`removePresence`/`getPresence`/`getDocumentPresenceExpired`/`removePresenceDocument`. |
| `editorDataRedisShardedSweep.js` | A pre-sharded "which (tenant, docId) pairs are due for a sweep" structure, shared by presence's doc-expiry sweep. |
| `editorDataRedisKeys.js` | Key/member encoding shared by all of the above. |

### Fail-closed locks, fail-open presence

The two stores deliberately behave opposite ways on a Redis error, because
the cost of being wrong differs:

- **Locks fail closed.** A Redis error or timeout comes back as a denial
  (`false` / `LOCKED`), never a throw and never a false grant. The caller
  already knows how to handle a denied lock (retry); it has no way to
  handle a lock that looked granted while it wasn't actually held.
  `commandTimeout: 300` on the Redis connection is what makes "Redis is
  unreachable" fail *promptly* rather than hang every save/auth request on
  that document indefinitely — fail-closed only works if the failure
  itself arrives quickly.
- **Presence fails open.** A Redis error falls back to the memory
  backend's local-connections-only view instead of throwing. The failure
  mode here is presence being wrong (a joiner waits when it shouldn't, or
  vice versa) — acceptable as a degrade. Letting the error propagate
  instead would turn a Redis outage into documents being unopenable, which
  is a worse failure than stale presence.

### Owner-token locks, not fencing tokens

`editorDataRedisSaveLock.js`'s locks are reentrant acquire-or-refresh by
the same owner with stateless release — not true Kleppmann fencing tokens.
A lock holder can prove it once acquired the lock, not that it still holds
it at the moment a write actually lands. This is a known, currently
accepted gap; it has not been evaluated against the actual write path, so
treat it as open rather than "fine because X."

### Key encoding and the sharded sweep

`editorDataRedisKeys.js` exists because naively joining `tenant` and
`docId` with a separator can collide (`tenant="a:b", docId="c"` vs.
`tenant="a", docId="b:c"`, joined on `:`) — every key and sorted-set member
goes through `encodeURIComponent` first so this can't happen.

`editorDataRedisShardedSweep.js` backs presence's "which documents have no
live presence left at all" sweep with N sorted sets rather than one, so it
stays Redis-Cluster-ready (a single global structure can't be sharded
across hash slots) and so a thundering herd of due entries can't be claimed
and processed in a single unbounded call. It's written generically enough
that another sweep needing the same claim-once semantics (e.g. a future
force-save timer) could reuse it instead of duplicating the Lua scripts.

## Testing

`tests/unit/editorDataRedisLocks.tests.js`, `editorDataRedisPresence.tests.js`,
and `editorDataRedisKeys.tests.js` cover the modules above against a real
Redis via `redis-memory-server` (an in-memory Redis, no container needed —
portable to CI). Covered: cross-replica lock/presence discrimination
against isolated instances, reentrancy and TTL expiry, key-collision
avoidance, unlock/lockAuth outcomes, HASH/ZSET write atomicity, the sharded
sweep, fail-closed and fail-open behavior on a simulated Redis error
(verified via the actual fallback call, not just "didn't throw"), and
`cleanDocumentOnExit` correctly leaving a still-connected viewer's presence
entry untouched.

**What this suite does not cover:** two real docservice processes actually
talking to the same Redis and behaving correctly together end-to-end.
That was verified manually — two real EO docservice replicas sharing one
Redis, behind a real WOPI host (Nextcloud + the `office` app), with two
independent browser sessions split across the two replicas for the same
document — but that setup is not a committed integration test. It
confirmed, empirically, the actual real-world claim this module exists to
support: a joiner on one replica sees an editor already active on the
other, and a WOPI-level lock survives one co-author disconnecting while
another remains active on a different replica. Turning that manual setup
into a committed, CI-runnable integration test is still open.

## Known gaps

- Owner-token locks are not fencing tokens (see above) — open, not
  evaluated against the write path.
- Block locks, messages, save-state, force-save, and telemetry are still
  entirely `editorDataMemory`-backed and therefore still single-replica-only.
- No committed multi-replica integration test exists; the cross-replica
  claim above has only been verified manually.
- One question from manual testing was never resolved either way: whether
  the WOPI-level lock reliably releases once the *last* real editor
  disconnects. The one attempt to observe this found no evidence the
  disconnect-cleanup code path had fired within the observation window —
  more likely a limitation of that manual test's timing than a real
  regression, but this was not confirmed in either direction.
