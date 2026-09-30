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
 * The current entries are all literal paths. For a literal pattern,
 * `fs.statSync(resolved).isFile()` is equivalent to pkg's own
 * `tinyglobby.globSync([resolved], {absolute, dot})` followed by an isFile check,
 * so resolution here is faithful without pulling in a glob dependency. An entry
 * that contains actual glob syntax is refused rather than guessed at (see below),
 * so the guard can never diverge from pkg by mis-resolving a pattern.
 *
 * Components are discovered, not hardcoded: any package.json (outside node_modules)
 * carrying a `pkg.scripts` block is checked, so a newly added component is covered
 * automatically instead of silently escaping the guard.
 *
 * Run after `npm install`: some entries point into `node_modules` (axios, statsd)
 * and only exist post-install, exactly as pkg requires.
 */

const fs = require('fs');
const path = require('path');

// Never descend into these while discovering components.
const DISCOVERY_SKIP_DIRS = new Set(['node_modules', 'tests', '.git']);

// Glob syntax picomatch (pkg's matcher) acts on. Bare `@ + !` are NOT globs on
// their own (only as extglobs such as `@(...)`, still caught here via `(`), so they
// are excluded: a literal path like `node_modules/@scope/pkg/index.js` must not be
// mistaken for a pattern.
const GLOB_SYNTAX = /[*?[\]{}()]/;

function hasPkgScripts(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Array.isArray(manifest.pkg && manifest.pkg.scripts);
  } catch {
    return false;
  }
}

/**
 * Find every component that carries a `pkg.scripts` block. Scans the repo's own
 * directories (depth 1, plus one nested level so `AdminPanel/server` is found),
 * skipping node_modules and test fixtures.
 * @returns {string[]} component paths relative to repoRoot, sorted
 */
function discoverComponents(repoRoot) {
  const components = [];
  const scan = (relDir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, relDir), {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || DISCOVERY_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (hasPkgScripts(path.join(repoRoot, rel))) {
        components.push(rel);
      }
      if (depth > 1) {
        scan(rel, depth - 1);
      }
    }
  };
  scan('', 2);
  return components.sort();
}

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
    if (GLOB_SYNTAX.test(entry)) {
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
 * Check every component's pkg.scripts entries. Components are discovered from the
 * repo unless an explicit list is passed (used by the tests against fixtures).
 * @returns {Array<{component: string, entry: string, reason: string}>} failures
 */
function checkAll(repoRoot, components) {
  const list = components || discoverComponents(repoRoot);
  return list.flatMap(component => checkComponent(repoRoot, component));
}

module.exports = {checkComponent, checkAll, discoverComponents};

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..');
  const components = discoverComponents(repoRoot);
  console.log(`pkg.scripts guard: checking ${components.length} component(s): ${components.join(', ')}`);
  const failures = checkAll(repoRoot, components);

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
