import { describe, expect, it } from '@jest/globals';

import { triageLayoutFor } from '../layout';

import { breakpoints } from '@/design/tokens';

const PHONE_WIDTH = 375;

describe('triageLayoutFor', () => {
  it('stacks on a phone', () => {
    expect(triageLayoutFor(PHONE_WIDTH)).toBe('stacked');
  });

  it('stacks one point below the large breakpoint', () => {
    expect(triageLayoutFor(breakpoints.lg - 1)).toBe('stacked');
  });

  it('splits exactly at the large breakpoint', () => {
    expect(triageLayoutFor(breakpoints.lg)).toBe('split');
  });

  it('splits above it', () => {
    expect(triageLayoutFor(breakpoints.xl)).toBe('split');
  });
});
