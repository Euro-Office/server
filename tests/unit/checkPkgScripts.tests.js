const path = require('path');
const {describe, test, expect} = require('@jest/globals');

const {checkComponent, checkAll, discoverComponents} = require('../../tools/check-pkg-scripts');

const FIXTURES = path.join(__dirname, '../fixtures/pkgScripts');

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
    expect(failures[0].reason).toMatch(/glob/i);
  });

  test('treats a leading "!" entry as an exclusion, not a file requirement', () => {
    const failures = checkComponent(FIXTURES, 'negation');
    expect(failures).toEqual([]);
  });

  test('flags a non-string entry', () => {
    const failures = checkComponent(FIXTURES, 'nonString');
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatch(/not a string/);
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

  test('discovers only components that declare pkg.scripts', () => {
    const components = discoverComponents(FIXTURES);
    // Every fixture with a pkg.scripts block is found...
    expect(components).toEqual(expect.arrayContaining(['valid', 'zeroMatch', 'scopedLiteral', 'globEntry', 'negation', 'nonString']));
    // ...and the pkg-block-without-scripts fixture is not.
    expect(components).not.toContain('noScripts');
  });
});
