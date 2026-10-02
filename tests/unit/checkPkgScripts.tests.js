const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawnSync} = require('child_process');
const {describe, test, expect, afterEach} = require('@jest/globals');

const {checkComponent, checkAll, discoverComponents} = require('../../tools/check-pkg-scripts');

const FIXTURES = path.join(__dirname, '../fixtures/pkgScripts');
const GUARD = path.join(__dirname, '../../tools/check-pkg-scripts.js');

function runGuard(repoRoot) {
  return spawnSync(process.execPath, [GUARD, repoRoot], {encoding: 'utf8'});
}

// Some cases can't be committed fixtures (a glob-char dir name, a node_modules folder, a
// symlink), so build them in a temp dir and clean up after each test.
const tempDirs = [];
function makeTempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function writeComponent(root, relDir, scripts, realFiles = []) {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, {recursive: true});
  for (const f of realFiles) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), {recursive: true});
    fs.writeFileSync(path.join(dir, f), 'module.exports = {};\n');
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'c', version: '1.0.0', pkg: {scripts}}));
  return dir;
}
afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), {recursive: true, force: true});
  }
});

describe('pkg.scripts guard', () => {
  test('passes when every entry resolves to a file', () => {
    const failures = checkComponent(FIXTURES, 'valid');
    expect(failures).toEqual([]);
  });

  test('fails on an entry that matches no file, naming the entry and component', () => {
    const failures = checkComponent(FIXTURES, 'zeroMatch');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({component: 'zeroMatch', entry: './sources/missing.js'});
    expect(failures[0].reason).toMatch(/matches no file/);
    // The entry that does resolve must not be reported.
    expect(failures.some(f => f.entry === './sources/existing.js')).toBe(false);
  });

  test('treats a literal scoped-package path as a file, not a glob', () => {
    // Regression: bare `@` must not be read as glob syntax, or a valid
    // `node_modules/@scope/...` entry would be wrongly refused.
    const failures = checkComponent(FIXTURES, 'scopedLiteral');
    expect(failures).toEqual([]);
  });

  test('refuses a glob entry rather than guessing (stays faithful to pkg)', () => {
    const failures = checkComponent(FIXTURES, 'globEntry');
    expect(failures).toHaveLength(1);
    expect(failures[0].entry).toBe('./sources/*.js');
    // Assert the refusal reason specifically: `/glob/i` would also match the fixture folder
    // name "globEntry" in a "matches no file" message, so it couldn't detect the branch being lost.
    expect(failures[0].reason).toMatch(/not supported by this guard/);
  });

  test('treats a leading "!" entry as an exclusion, not a file requirement', () => {
    const failures = checkComponent(FIXTURES, 'negation');
    expect(failures).toEqual([]);
  });

  test('fails a positive entry cancelled by a literal negation of the same file', () => {
    // pkg passes all entries to one glob call, so "!./sources/x.js" removes "./sources/x.js"
    // and the binary ships without it. The file exists, so this is not "matches no file".
    const failures = checkComponent(FIXTURES, 'negationCancel');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({component: 'negationCancel', entry: './sources/x.js'});
    expect(failures[0].reason).toMatch(/cancelled by a negation/);
  });

  test('refuses a negation that contains glob syntax', () => {
    const failures = checkComponent(FIXTURES, 'negationGlob');
    expect(failures).toHaveLength(1);
    expect(failures[0].entry).toBe('!./sources/*.tmp.js');
    expect(failures[0].reason).toMatch(/not supported by this guard/);
  });

  test('flags a checkout path that itself contains glob metacharacters', () => {
    // pkg globs the whole resolved path, so a repo under e.g. "a (b)/" bundles nothing even
    // though the entry is a valid literal. The control (clean path) must pass.
    const globRoot = makeTempRepo('g (x)-');
    writeComponent(globRoot, 'comp', ['./sources/f.js'], ['sources/f.js']);
    const globFailures = checkComponent(globRoot, 'comp');
    expect(globFailures).toHaveLength(1);
    expect(globFailures[0].reason).toMatch(/checkout path contains glob metacharacters/);

    const cleanRoot = makeTempRepo('clean-');
    writeComponent(cleanRoot, 'comp', ['./sources/f.js'], ['sources/f.js']);
    expect(checkComponent(cleanRoot, 'comp')).toEqual([]);
  });

  test('flags a non-string entry', () => {
    const failures = checkComponent(FIXTURES, 'nonString');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/not a string/);
  });

  test('handles a string-form scripts (pkg wraps a non-array) as one entry', () => {
    // Regression: a string must be treated as a single entry, not iterated per character,
    // and the component must still be discovered.
    const failures = checkComponent(FIXTURES, 'stringForm');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({component: 'stringForm', entry: './sources/missing.js'});
    expect(failures[0].reason).toMatch(/matches no file/);
  });

  test('ignores a pkg block that has no scripts', () => {
    const failures = checkComponent(FIXTURES, 'noScripts');
    expect(failures).toEqual([]);
  });

  test('reports a missing package.json instead of throwing', () => {
    const failures = checkComponent(FIXTURES, 'does-not-exist');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/cannot read package.json/);
  });

  test('checkAll aggregates failures across components', () => {
    const failures = checkAll(FIXTURES, ['valid', 'zeroMatch']);
    expect(failures).toHaveLength(1);
    expect(failures[0].component).toBe('zeroMatch');
  });

  test('CLI exits non-zero and uses a neutral header when a glob entry is refused', () => {
    // A glob entry is a real failure, but pkg would bundle it fine, so the output must not
    // claim it "matches no file" or would be "dropped silently".
    const root = makeTempRepo('cli-glob-');
    writeComponent(root, 'comp', ['./sources/*.js'], ['sources/a.js']);
    const res = runGuard(root);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/found 1 problem/);
    expect(res.stderr).toMatch(/not supported by this guard/);
    expect(res.stderr).not.toMatch(/match no file|dropped.*silently/i);
  });

  test('CLI exits zero when every entry resolves', () => {
    const root = makeTempRepo('cli-ok-');
    writeComponent(root, 'comp', ['./sources/a.js'], ['sources/a.js']);
    const res = runGuard(root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/every entry resolves/);
  });

  test('discovery prunes node_modules, tests and .git (decoys there are not found)', () => {
    const root = makeTempRepo('prune-');
    writeComponent(root, 'realComp', ['./sources/a.js'], ['sources/a.js']);
    // Decoys that declare pkg.scripts but live in pruned dirs; must not be discovered.
    writeComponent(root, 'node_modules/dep', ['./x.js']);
    writeComponent(root, 'tests/fixtureComp', ['./x.js']);
    writeComponent(root, '.git/hookComp', ['./x.js']);
    const found = discoverComponents(root);
    expect(found).toContain('realComp');
    expect(found).not.toContain(path.join('node_modules', 'dep'));
    expect(found).not.toContain(path.join('tests', 'fixtureComp'));
    expect(found.some(c => c.startsWith('.git'))).toBe(false);
  });

  test('discovery does not follow symlinked directories', () => {
    const root = makeTempRepo('symlink-');
    writeComponent(root, 'realComp', ['./sources/a.js'], ['sources/a.js']);
    // A component reachable only through a symlink; if the walk followed it, it would appear.
    const external = makeTempRepo('symlink-target-');
    writeComponent(external, 'externalComp', ['./x.js']);
    fs.symlinkSync(path.join(external, 'externalComp'), path.join(root, 'linkComp'), 'dir');
    const found = discoverComponents(root);
    expect(found).toContain('realComp');
    expect(found).not.toContain('linkComp');
  });

  test('discovers only components that declare pkg.scripts, at any depth', () => {
    const components = discoverComponents(FIXTURES);
    // Every fixture with a pkg.scripts block is found...
    expect(components).toEqual(expect.arrayContaining(['valid', 'zeroMatch', 'scopedLiteral', 'globEntry', 'negation', 'nonString', 'stringForm']));
    // ...including one nested deeper than two levels (discovery is unbounded)...
    expect(components).toContain(path.join('nested', 'inner', 'deepComponent'));
    // ...and the pkg-block-without-scripts fixture is not.
    expect(components).not.toContain('noScripts');
  });
});
