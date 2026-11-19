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
 * The current entries are all literal file paths. For a literal file,
 * `fs.statSync(resolved).isFile()` is equivalent to pkg's own
 * `tinyglobby.globSync([resolved], {absolute, dot})` followed by an isFile check, so resolution
 * here is faithful without pulling in a glob dependency. An entry that is a glob, resolves to a
 * directory (pkg would expand both), or sits under a checkout path containing glob metacharacters
 * is refused rather than guessed at, so the guard does not silently diverge from pkg. tinyglobby
 * (pkg's matcher) is the documented upgrade path if entry shapes ever need full resolution.
 *
 * Verified against pkg's matcher, tinyglobby ^0.2.11, which every pkg version in use here
 * depends on (6.14.x on Node 20 through 6.23.x on Node 22). Re-check this guard if pkg
 * switches its glob engine.
 *
 * Components are discovered, not hardcoded: any package.json (outside node_modules)
 * carrying a `pkg.scripts` block is checked, so a newly added component is covered
 * automatically instead of silently escaping the guard.
 *
 * Run after `npm install`: some entries point into `node_modules` (axios in Common, statsd in
 * Metrics) and only exist post-install, exactly as pkg requires. The two build contexts install
 * different sets: the production Dockerfile installs all components, while server e2e installs
 * Common/DocService/FileConverter/Metrics but NOT AdminPanel/server. The guard checks every
 * discovered component regardless, so e2e also checks AdminPanel/server. That is harmless today
 * (its entries are DocService source paths, independent of its own install) but would false-FAIL
 * in e2e if AdminPanel/server ever listed one of its own `node_modules` files.
 *
 * Scope of assurance: the guard verifies that each discovered component's `pkg.scripts` entries
 * resolve to a file. It does NOT model the actual `pkg` invocation list (it cannot catch a
 * component that resolves but is never packaged), and it does NOT check `pkg.assets` (e.g.
 * SpellChecker bundles only via assets and is uncovered). "Guard green" means "no listed script
 * entry is missing", not "the shipped binary is complete".
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

// Shared message for an entry (positive or negation) that resolves to a directory. pkg expands a
// directory to its files recursively; this guard does not model that, so it refuses rather than
// guess (a positive would otherwise look "missing", a negation would silently cancel a subtree).
const DIRECTORY_REASON =
  'entry resolves to a directory; this guard validates literal file paths and does not model ' +
  "pkg's directory expansion. List the files explicitly, or adopt pkg's matcher (tinyglobby) to " +
  'resolve directory entries.';

// Stable machine-readable failure codes. Tests and any consumer should branch on `kind`, never
// on the human-readable `reason` text, so messages can be reworded without breaking anything.
const KIND = {
  MISSING_FILE: 'missing-file',
  NEGATION_CANCELLED: 'negation-cancelled',
  GLOB_UNSUPPORTED: 'glob-unsupported',
  DIRECTORY_UNSUPPORTED: 'directory-unsupported',
  PATH_GLOB: 'path-glob',
  NON_STRING: 'non-string',
  UNREADABLE_MANIFEST: 'unreadable-manifest'
};

// pkg accepts `scripts` as an array or a single string. Match that: a string becomes one entry,
// a falsy value (empty string / undefined) means "no scripts". Any other shape (number, object)
// is ignored here and left to pkg, which rejects it loudly ("Config items must be strings"), so
// it cannot ship silently.
function normalizeScripts(scripts) {
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
 *
 * Fails open: a directory that cannot be read, or whose name is a dotfile, is skipped
 * silently rather than aborting the walk. Because this scans the entire repo, failing closed
 * would break the build on any unrelated unreadable directory; in the build contexts the tree
 * is fully readable, so nothing is skipped in practice.
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
 * @returns {Array<{component: string, entry: string, reason: string, kind: string}>} failures
 */
function checkComponent(repoRoot, component) {
  const componentDir = path.join(repoRoot, component);
  const manifestPath = path.join(componentDir, 'package.json');
  const failures = [];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return [{component, entry: 'package.json', reason: `cannot read package.json: ${err.message}`, kind: KIND.UNREADABLE_MANIFEST}];
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
        reason: 'checkout path contains glob metacharacters; pkg bundles nothing for this component',
        kind: KIND.PATH_GLOB
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
      failures.push({component, entry, reason: GLOB_REASON, kind: KIND.GLOB_UNSUPPORTED});
      continue;
    }
    const negated = path.join(componentDir, pattern);
    let negatesDir = false;
    try {
      negatesDir = fs.statSync(negated).isDirectory();
    } catch {
      negatesDir = false;
    }
    if (negatesDir) {
      // pkg would exclude the whole subtree; we only track exact-path exclusions, so refuse.
      failures.push({component, entry, reason: DIRECTORY_REASON, kind: KIND.DIRECTORY_UNSUPPORTED});
    } else {
      excluded.add(negated);
    }
  }

  // Second pass: check each positive entry.
  for (const entry of scripts) {
    if (typeof entry !== 'string') {
      failures.push({
        component,
        entry: String(entry),
        reason: 'entry is not a string; pkg rejects it ("Config items must be strings")',
        kind: KIND.NON_STRING
      });
      continue;
    }
    if (entry.startsWith('!')) {
      continue; // handled in the first pass
    }
    if (GLOB_SYNTAX.test(entry)) {
      failures.push({component, entry, reason: GLOB_REASON, kind: KIND.GLOB_UNSUPPORTED});
      continue;
    }
    // pkg resolves each entry as path.join(base, entry), then bundles it iff isFile.
    const resolved = path.join(componentDir, entry);
    let stat = null;
    try {
      stat = fs.statSync(resolved);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      // pkg would expand the directory to its files; we do not model that, so refuse.
      failures.push({component, entry, reason: DIRECTORY_REASON, kind: KIND.DIRECTORY_UNSUPPORTED});
    } else if (!stat || !stat.isFile()) {
      failures.push({
        component,
        entry,
        reason: `matches no file; pkg drops it silently, so the module is MODULE_NOT_FOUND at runtime (${path.relative(repoRoot, resolved)})`,
        kind: KIND.MISSING_FILE
      });
    } else if (excluded.has(resolved)) {
      failures.push({
        component,
        entry,
        reason: `cancelled by a negation entry; pkg bundles nothing for it (${path.relative(repoRoot, resolved)})`,
        kind: KIND.NEGATION_CANCELLED
      });
    }
  }

  return failures;
}

/**
 * Check every component's pkg.scripts entries. Components are discovered from the
 * repo unless an explicit list is passed (used by the tests against fixtures).
 * @returns {Array<{component: string, entry: string, reason: string, kind: string}>} failures
 */
function checkAll(repoRoot, components) {
  const list = components || discoverComponents(repoRoot);
  return list.flatMap(component => checkComponent(repoRoot, component));
}

module.exports = {checkComponent, checkAll, discoverComponents, KIND};

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
