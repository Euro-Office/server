/*
 * SPDX-FileCopyrightText: 2026 Euro-Office contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use strict';

/*
 * Guard against a `pkg.scripts` entry that resolves to no file.
 *
 * The service binaries are produced with @yao-pkg/pkg, which bundles the files
 * listed under the `pkg.scripts` block of each component's package.json. pkg
 * resolves every entry with `path.join(componentDir, entry)` and then globs it;
 * an entry that matches no file is dropped silently (no warning, exit 0), so the
 * module is simply absent from the binary and the service crashes at runtime with
 * MODULE_NOT_FOUND. This script turns that silent omission into a build failure.
 *
 * Every current `pkg.scripts` entry is a literal path (no glob metacharacters).
 * For a literal pattern, `fs.statSync(resolved).isFile()` is equivalent to pkg's
 * own `tinyglobby.globSync([resolved], {absolute, dot})` followed by an isFile
 * check, so the resolution here is faithful without a glob dependency. If a real
 * glob is ever added to `pkg.scripts`, the guard refuses to guess (see below)
 * rather than diverge from pkg.
 *
 * Run after `npm install`: some entries point into `node_modules` (axios, statsd)
 * and only exist post-install, exactly as pkg requires.
 */

const fs = require('fs');
const path = require('path');

// Components whose package.json carries a `pkg` block consumed by @yao-pkg/pkg.
const COMPONENTS = ['DocService', 'FileConverter', 'Metrics', 'AdminPanel/server'];

// picomatch metacharacters. tinyglobby (pkg's matcher) treats an entry containing
// any of these as a glob; a plain isFile check would be wrong for those.
const GLOB_METACHARS = /[*?[\]{}()!+@]/;

/**
 * Check one component's pkg.scripts entries.
 * @returns {Array<{component: string, entry: string, reason: string}>} failures
 */
function checkComponent(repoRoot, component) {
  const componentDir = path.join(repoRoot, component);
  const manifestPath = path.join(componentDir, 'package.json');
  const failures = [];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return [{component, entry: 'package.json', reason: `cannot read package.json: ${err.message}`}];
  }

  const scripts = manifest.pkg && manifest.pkg.scripts;
  if (!scripts) {
    return failures;
  }

  for (const entry of scripts) {
    if (typeof entry !== 'string') {
      failures.push({component, entry: String(entry), reason: 'entry is not a string'});
      continue;
    }
    // A leading '!' is a pkg exclusion (negation), not a file requirement.
    if (entry.startsWith('!')) {
      continue;
    }
    if (GLOB_METACHARS.test(entry)) {
      failures.push({
        component,
        entry,
        reason:
          'glob pattern in pkg.scripts is not supported by this guard; all entries are ' +
          "literal paths today. Extend the guard with pkg's matcher (tinyglobby) before " +
          'adding a glob here so resolution stays faithful to pkg.'
      });
      continue;
    }
    // pkg resolves each entry as path.join(base, entry), then bundles it iff isFile.
    const resolved = path.join(componentDir, entry);
    let isFile = false;
    try {
      isFile = fs.statSync(resolved).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      failures.push({component, entry, reason: `matches no file (${path.relative(repoRoot, resolved)})`});
    }
  }

  return failures;
}

/**
 * Check every component's pkg.scripts entries.
 * @returns {Array<{component: string, entry: string, reason: string}>} failures
 */
function checkAll(repoRoot, components = COMPONENTS) {
  return components.flatMap(component => checkComponent(repoRoot, component));
}

module.exports = {COMPONENTS, checkComponent, checkAll};

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const failures = checkAll(repoRoot);

  if (failures.length > 0) {
    console.error('pkg.scripts guard: the following entries match no file:\n');
    for (const failure of failures) {
      console.error(`  [${failure.component}] ${failure.entry}`);
      console.error(`      ${failure.reason}`);
    }
    console.error(
      '\n@yao-pkg/pkg would drop these entries from the packaged binary silently, ' +
        'causing MODULE_NOT_FOUND at runtime. Fix the path or remove the entry.'
    );
    process.exit(1);
  }

  console.log('pkg.scripts guard: every entry resolves to a file.');
}
