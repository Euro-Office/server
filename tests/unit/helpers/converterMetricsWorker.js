/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

// Cluster worker for converterMetrics.tests.js: records one x2t run like a converter worker does
const cluster = require('cluster');
const path = require('path');

// Config paths are relative to DocService, the working directory of the unit tests
process.chdir(path.join(__dirname, '../../../DocService'));
const metrics = require('../../../Common/sources/metrics');

const workerMetrics = metrics.registerConverterWorker(String(cluster.worker.id));
workerMetrics.x2tRunning.inc();
workerMetrics.x2tDuration.observe({tool: 'x2t', result: 'ok'}, 0.4);
process.send({type: 'ready'});
