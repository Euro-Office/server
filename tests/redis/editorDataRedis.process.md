# Independent-process `editorDataRedis` tests

`editorDataRedis.process.tests.js` forks two Node.js workers, `replica-a` and
`replica-b`, and waits for both workers to connect before running any scenario.
Each worker has its own `EditorData`/`EditorStat` instances, event loop, timers,
Redis connection, PID, and replica identity. The parent communicates with the
workers using structured Node.js IPC messages containing request IDs. Every
operation has a deadline and includes the scenario and replica in protocol
errors.

The successful-operation trace is run once against one in-memory store and
once against the two Redis workers. The comparison is limited to observable
return values and state for methods where `editorDataMemory` is a meaningful
oracle: locks and unlock enums, object-lock conflict/removal behavior,
messages, saved get-and-delete, force-save CAS transitions, first-write-wins
force-save timers, unique-user statistics, and notification mutexes. Redis
presence, expiry indexes, and expiration claims are tested directly because
the memory implementation intentionally does not store presence.

Redis-only scenarios use ordered operations or two-worker barriers for
presence visibility/removal/expiry, lock ownership and TTL expiry, message
races, atomic saved reads, force-save start races, timer claims, and mutex
races. The crash scenario wraps the first presence EVAL in `replica-a`, waits
until Redis has acknowledged that command, then holds the worker before the
public method can complete. The parent sends `SIGKILL`; `replica-b` must still
see the committed presence, answer a ping, acquire/release a lock, and clean up
the remaining presence.

Every test uses a random prefix derived from `TEST_REDIS_PREFIX`. Workers are
shut down explicitly, surviving children are terminated in the cleanup path,
and the parent scans/deletes only that unique prefix. The suite is currently
standalone-only. The existing standalone CI job discovers it through
`tests/redis`; the cluster job skips it so a future cluster harness can reuse
the worker protocol without changing Sentinel configuration.

Not covered here: Sentinel topology/failover, Redis connection-failure return
policy, crash recovery of a lost expiration claim (the production lease is
five minutes), and packaging or force-save serialization concerns.
