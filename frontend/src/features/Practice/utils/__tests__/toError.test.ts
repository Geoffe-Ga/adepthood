import { describe, expect, it } from '@jest/globals';

import { toError } from '../toError';

describe('toError', () => {
  it('passes an Error instance through by reference', () => {
    const err = new Error('boom');
    expect(toError(err)).toBe(err);
  });

  it('wraps a string into an Error carrying that message', () => {
    const wrapped = toError('boom');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('boom');
  });

  it('wraps a plain object via String(value)', () => {
    const wrapped = toError({});
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('[object Object]');
  });

  it('wraps a number via String(value)', () => {
    const wrapped = toError(42);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('42');
  });
});
