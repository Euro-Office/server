<!--
SPDX-FileCopyrightText: 2026 Euro-Office contributors
SPDX-License-Identifier: AGPL-3.0-only
-->

# Final-save RabbitMQ integration tests

The normal `npm test` command runs unit tests followed by this suite. The existing
Service unit tests GitHub Actions workflow runs that same command on Ubuntu with Node 24. Changes under this directory trigger the workflow, including runner and
documentation changes.

To run only this suite from the server repository root, with its normal root,
Common and DocService npm packages installed:

```sh
npm run test:rabbitmq
```

Requires a running Docker daemon, Bash, GNU `timeout`, and Node.js. Docker pulls
`rabbitmq:3` if needed. No other services are started.
No new npm dependencies are required.

The command starts a dedicated container with a unique name and vhost, an
OS-assigned loopback AMQP port, and disposable test credentials. It waits for the
broker's health signal before running Jest. It uses production queue names,
options, TTL/dead-letter routing, publisher confirmations and automatic
reconnection. Readiness, delivery waits and the test process have deadlines.
The exit trap removes the container and its anonymous volumes, including all
queues/exchanges/messages, on success, failure, interruption or test timeout.
Connections and delivery listeners are also closed by the tests.

For an untrappable interruption (such as SIGKILL), find this run's container with
`docker ps -a --filter name=eo-rabbitmq-tests-` and remove that specific container
with `docker rm -fv <container-name>`. Never point these tests at a development or
shared broker. `EO_RABBITMQ_TEST_URL` is set internally by the runner; there is no
fallback to the application broker.

The two tests cover:

- A confirmed delayed final-save retry expiring into the configured dead-letter
  exchange/queue, then passing through production `handleDeadLetter` and confirmed
  response publication. The complete payload, including the save key (operation
  ID), saved state, accepted-callback metadata and retry counters, is preserved.
- An unacknowledged response redelivered after consumer socket loss and production
  reconnection. Invoking the old acknowledgement callback cannot settle the new
  delivery: another connection loss must redeliver it again. A live callback then
  settles it, verified by reconnecting and receiving a sentinel instead.

These tests stop at the queue boundary. SQL/Redis saved-state claims, callback and
WOPI idempotency, cleanup, publication failure budgets and abandonment remain in
the existing deterministic unit tests. No application server or document editor
is started. `npm run 'unit tests'` continues to select only unit tests.

`npm run tests` retains the broader selection (including database and storage
integration tests, which need their own services), then runs this suite through
its disposable-broker runner. `npm run tests:dev` watches the other suites; run
`npm run test:rabbitmq` separately to repeat the broker tests.
