const path = require('path');
const {describe, test, expect} = require('@jest/globals');

const {checkComponent, checkAll} = require('../../tools/check-pkg-scripts');

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
});
