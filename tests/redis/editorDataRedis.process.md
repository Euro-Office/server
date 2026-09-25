# Independent-process `editorDataRedis` tests

`editorDataRedis.process.tests.js` verifies behavior that requires two
independent Node.js processes sharing the same Redis backend or topology. It
is separate from the regular Redis tests because those tests create multiple
storage instances in one process.

## What the suite does

The suite forks two workers, `replica-a` and `replica-b`. Each worker has its
own `EditorData` and `EditorStat` instances, event loop, timers, Redis
connection, process ID, and replica identity. The parent communicates with the
workers through structured Node.js IPC messages containing request IDs.
Every operation has a deadline, and protocol errors include the scenario and
replica that produced them.

One test compares a successful-operation trace between the in-memory backend
and the two Redis workers. The comparison covers observable results for locks,
unlock enums, object-lock conflicts and removal, messages, saved-value
read/delete operations, force-save transitions, first-write-wins force-save
timers, unique-user statistics, and notification mutexes.

Redis-only scenarios cover cross-process visibility and races for presence,
presence expiry, locks, messages, saved values, force-save operations, timers,
and notification mutexes. The crash scenario kills `replica-a` after Redis
has acknowledged a presence write but before the public method completes.
`replica-b` must still observe the committed presence, answer a ping, acquire
and release a lock, and remove the remaining presence.

## Cleanup and topology coverage

Each test uses a unique prefix derived from `TEST_REDIS_PREFIX`. Workers are
shut down explicitly, surviving children are terminated during cleanup, and
the parent scans and deletes keys belonging to that prefix.

The process suite runs in the standalone, Cluster, and Sentinel Redis jobs.
The workers use the same topology configuration as the parent test process.
Cleanup uses a direct client for standalone Redis, scans every Cluster master,
and scans the Sentinel-discovered master.

The test topology is selected through the `TEST_REDIS_*` environment variables.
Those values are parsed and validated by `testConfig.js`, including the
standalone host and port, Cluster root nodes, Sentinel root nodes and master
name, key prefix, database number, and mutually exclusive topology flags.

The original harness guarded the whole `describe` block with
`TEST_REDIS_CLUSTER !== 'true'`, so Jest discovered the file but skipped every
independent-process scenario in the Cluster job. That was a test-selection
limitation, not a Redis Cluster limitation. The workers now create the same
topology-selected client as the parent, and Cluster cleanup scans each master.

One separate single-process test remains intentionally standalone-only:
`editorDataRedis.tests.js` checks timeout recovery for a Redis `MULTI`
transaction, while the Cluster implementation routes command batches
individually to preserve hash-slot correctness. This exclusion is limited to
that transaction test and does not skip the process suite or its Cluster
scenarios.

## Not covered by this suite

This file does not test Sentinel master failover, Redis connection-failure
policy, recovery of a lost expiration claim, packaged-binary loading, or
force-save payload serialization. Those concerns belong to separate topology,
failure-policy, packaging, and regular behavior tests respectively.
