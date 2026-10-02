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
 * so resolution here is faithful without pulling in a glob dependency. An entry (or the
 * checkout path) that contains actual glob syntax is reported rather than guessed at (see
 * below), so the guard does not silently diverge from pkg by mis-resolving a pattern.
 *
 * Verified against pkg's matcher, tinyglobby ^0.2.11, which every pkg version in use here
 * depends on (6.14.x on Node 20 through 6.23.x on Node 22). Re-check this guard if pkg
 * switches its glob engine.
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

// Shared message for an entry (positive or negation) that contains glob syntax. The guard
// resolves literal paths only; a real glob is refused rather than resolved with a lookalike
// matcher, so it does not diverge from pkg by mis-resolving a pattern.
const GLOB_REASON =
  'glob pattern in pkg.scripts is not supported by this guard; all entries are literal paths ' +
  "today. Extend the guard with pkg's matcher (tinyglobby) before adding a glob here so " +
  'resolution stays faithful to pkg.';

// pkg accepts `scripts` as either an array or a single string (it wraps a non-array in an
// array before globbing), so normalise the same way before inspecting the entries.
function normalizeScripts(scripts) {
  // pkg only processes a truthy `scripts`, so an empty string / undefined means "no scripts".
  if (!scripts) {
    return [];
  }
  if (typeof scripts === 'string') {
    return [scripts];
  }
  return Array.isArray(scripts) ? scripts : [];
}

// A dir counts as a component only if its package.json parses and declares a non-empty
// pkg.scripts (array or string). Validating that the manifest is well-formed JSON is not this
// guard's job: the build parses each component's own package.json and fails first on a malformed one.
function hasPkgScripts(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return normalizeScripts(manifest.pkg && manifest.pkg.scripts).length > 0;
  } catch {
    return false;
  }
}

/**
 * Find every component that carries a `pkg.scripts` block. Recurses the whole repo,
 * pruning node_modules/.git/tests and not following symlinks, so the walk stays in
 * the source tree and cannot cycle (a real directory tree is acyclic).
 * @returns {string[]} component paths relative to repoRoot, sorted
 */
function discoverComponents(repoRoot) {
  const components = [];
  const scan = relDir => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, relDir), {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      // isDirectory() is false for a symlink, so symlinked dirs are never followed.
      if (!entry.isDirectory() || entry.name.startsWith('.') || DISCOVERY_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (hasPkgScripts(path.join(repoRoot, rel))) {
        components.push(rel);
      }
      scan(rel);
    }
  };
  scan('');
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

  const scripts = normalizeScripts(manifest.pkg && manifest.pkg.scripts);
  if (scripts.length === 0) {
    return failures;
  }

  // pkg globs path.join(componentDir, entry), i.e. the whole absolute path, so glob
  // metacharacters in the checkout path itself make every entry resolve to nothing. Report
  // that once instead of mislabelling each entry.
  if (GLOB_SYNTAX.test(componentDir)) {
    return [
      {
        component,
        entry: component,
        reason: 'checkout path contains glob metacharacters, so pkg would bundle nothing for this component'
      }
    ];
  }

  // pkg passes all entries to one glob call, so a negation (`!x`) removes any positive entry it
  // matches. First pass: record the paths literal negations exclude (and refuse glob negations,
  // which we cannot resolve faithfully, just like positive globs).
  const excluded = new Set();
  for (const entry of scripts) {
    if (typeof entry !== 'string' || !entry.startsWith('!')) {
      continue;
    }
    const pattern = entry.slice(1);
    if (GLOB_SYNTAX.test(pattern)) {
      failures.push({component, entry, reason: GLOB_REASON});
    } else {
      excluded.add(path.join(componentDir, pattern));
    }
  }

  // Second pass: check each positive entry.
  for (const entry of scripts) {
    if (typeof entry !== 'string') {
      failures.push({component, entry: String(entry), reason: 'entry is not a string (pkg would reject it with "Config items must be strings")'});
      continue;
    }
    if (entry.startsWith('!')) {
      continue; // handled in the first pass
    }
    if (GLOB_SYNTAX.test(entry)) {
      failures.push({component, entry, reason: GLOB_REASON});
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
      failures.push({
        component,
        entry,
        reason: `matches no file, so pkg drops it silently (MODULE_NOT_FOUND at runtime): ${path.relative(repoRoot, resolved)}`
      });
    } else if (excluded.has(resolved)) {
      failures.push({
        component,
        entry,
        reason: `cancelled by a negation entry, so pkg bundles nothing for it (${path.relative(repoRoot, resolved)})`
      });
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
  // Optional repo root argument lets the tests run the CLI against a fixture tree; defaults
  // to the repo this script lives in.
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
  const components = discoverComponents(repoRoot);
  console.log(`pkg.scripts guard: checking ${components.length} component(s): ${components.join(', ')}`);
  const failures = checkAll(repoRoot, components);

  if (failures.length > 0) {
    // Each failure carries its own reason (missing file, cancelled by negation, glob, bad path,
    // non-string). Keep the header neutral so it is not wrong for the non-"missing file" cases.
    console.error(`\npkg.scripts guard: found ${failures.length} problem(s) in pkg.scripts:\n`);
    for (const failure of failures) {
      console.error(`  [${failure.component}] ${failure.entry}`);
      console.error(`      ${failure.reason}`);
    }
    console.error('\nFix or remove the entries above.');
    process.exit(1);
  }

  console.log('pkg.scripts guard: every entry resolves to a file.');
}
