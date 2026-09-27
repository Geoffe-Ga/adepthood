import { describe, it, expect } from '@jest/globals';

import { claimCreateAttempt, type CreateKeyRef } from '../createKey';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('claimCreateAttempt (#2936)', () => {
  it('mints a uuid v4 on the first claim and reports it as not resent', () => {
    const ref: CreateKeyRef = { current: null };

    const first = claimCreateAttempt(ref);

    expect(first.key).toMatch(UUID_V4);
    expect(first.resent).toBe(false);
  });

  it('keeps the same key on every later claim, each one resent', () => {
    const ref: CreateKeyRef = { current: null };
    const first = claimCreateAttempt(ref);

    const second = claimCreateAttempt(ref);
    const third = claimCreateAttempt(ref);

    expect([second.key, third.key]).toEqual([first.key, first.key]);
    expect([second.resent, third.resent]).toEqual([true, true]);
    expect(ref.current?.attempts).toBe(3);
  });

  it('gives a separate create its own key', () => {
    const one = claimCreateAttempt({ current: null });
    const other = claimCreateAttempt({ current: null });

    expect(other.key).not.toBe(one.key);
  });
});
