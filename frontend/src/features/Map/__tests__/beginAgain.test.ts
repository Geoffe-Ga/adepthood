/* eslint-env jest */
/* global describe, it, expect */
import { BEGIN_AGAIN_COPY, cycleLabel } from '../beginAgain';

import { ranksOrShames } from './copyIntentRule';

describe('BEGIN_AGAIN_COPY', () => {
  it('exports heading, body, and action keys', () => {
    expect(typeof BEGIN_AGAIN_COPY.heading).toBe('string');
    expect(typeof BEGIN_AGAIN_COPY.body).toBe('string');
    expect(typeof BEGIN_AGAIN_COPY.action).toBe('string');
    expect(Object.keys(BEGIN_AGAIN_COPY).sort()).toEqual(['action', 'body', 'heading'].sort());
  });

  it('heading ranks or shames no one (intent rule, not a wordlist)', () => {
    expect(ranksOrShames(BEGIN_AGAIN_COPY.heading)).toBe(false);
  });

  it('body ranks or shames no one (intent rule, not a wordlist)', () => {
    expect(ranksOrShames(BEGIN_AGAIN_COPY.body)).toBe(false);
  });

  it('action ranks or shames no one (intent rule, not a wordlist)', () => {
    expect(ranksOrShames(BEGIN_AGAIN_COPY.action)).toBe(false);
  });

  it('copy contains leaving-whole language (the word "whole")', () => {
    const allCopy = Object.values(BEGIN_AGAIN_COPY).join(' ');
    expect(/whole/i.test(allCopy)).toBe(true);
  });
});

describe('cycleLabel', () => {
  it('cycleLabel(2) returns "Cycle 2"', () => {
    expect(cycleLabel(2)).toBe('Cycle 2');
  });

  it('cycleLabel(1) returns "Cycle 1"', () => {
    expect(cycleLabel(1)).toBe('Cycle 1');
  });

  it('cycleLabel(10) returns "Cycle 10"', () => {
    expect(cycleLabel(10)).toBe('Cycle 10');
  });
});
