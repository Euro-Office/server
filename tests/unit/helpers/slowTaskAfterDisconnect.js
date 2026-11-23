/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

// Cluster worker for converterMetrics.tests.js: reports a slow task after its IPC channel closed, then exits 0 if still alive
const cluster = require('cluster');
const path = require('path');

process.chdir(path.join(__dirname, '../../../DocService'));
const metrics = require('../../../Common/sources/metrics');

const workerMetrics = metrics.registerConverterWorker(String(cluster.worker.id));
process.disconnect();
workerMetrics.reportSlowTask({fileName: 'late.pptx', total: 12000});
setTimeout(() => process.exit(0), 200);
