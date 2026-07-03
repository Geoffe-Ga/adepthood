/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';

import { greeting } from '../greeting';

describe('greeting', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns "Good morning" before noon', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T08:00:00'));
    expect(greeting()).toBe('Good morning');
  });

  it('returns "Good afternoon" at the noon boundary', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00'));
    expect(greeting()).toBe('Good afternoon');
  });

  it('returns "Good afternoon" mid-afternoon', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T14:00:00'));
    expect(greeting()).toBe('Good afternoon');
  });

  it('returns "Good evening" at the 6pm boundary', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T18:00:00'));
    expect(greeting()).toBe('Good evening');
  });

  it('returns "Good evening" at night', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T20:00:00'));
    expect(greeting()).toBe('Good evening');
  });
});
