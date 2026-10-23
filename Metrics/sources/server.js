// SPDX-FileCopyrightText: 2026 Euro-Office contributors
// SPDX-License-Identifier: AGPL-3.0-only

const util = require('util');

// statsd 0.9.0 (latest release) still calls util.log, which Node 23 removed
util.log ??= (...args) => console.log(new Date().toISOString(), '-', ...args);

require('statsd/stats.js');
