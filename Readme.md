# Server

[![License](https://img.shields.io/badge/License-GNU%20AGPL%20V3-green.svg?style=flat)](https://www.gnu.org/licenses/agpl-3.0.en.html)

The backend server software layer which is a part of [Euro-Office Document Server](https://github.com/Euro-Office/DocumentServer) and is the base for all other components.

## Known limitation: Redis replication failover and locks

Redis replication failover is not currently lock-safe. If Redis fails immediately after granting a lock, the promoted replica may not have received that lock, allowing another client to acquire it. Redis-backed editor-data deployments should therefore not be described as fully failover-safe for locks.

Treat this as a deployment risk and a separate production-readiness follow-up. Sentinel support, command retries, and `WAIT` do not remove this limitation.

## License

Server is released under an GNU AGPL v3.0 license. See the LICENSE file for more information.
