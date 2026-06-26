/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { canonicalizeEmail } from '../canonicalizeEmail';

describe('canonicalizeEmail', () => {
  it('trims surrounding whitespace and lowercases', () => {
    expect(canonicalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });

  it('is idempotent on an already-canonical address', () => {
    expect(canonicalizeEmail('foo@bar.com')).toBe('foo@bar.com');
  });

  it('leaves the local/domain content otherwise intact', () => {
    expect(canonicalizeEmail('First.Last+tag@Example.org')).toBe('first.last+tag@example.org');
  });
});
