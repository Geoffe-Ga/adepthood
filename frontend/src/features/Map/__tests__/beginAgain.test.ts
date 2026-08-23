/* eslint-env jest */
/* global describe, it, expect */
import { BEGIN_AGAIN_COPY, cycleLabel } from '../beginAgain';

import { ranksOrShames } from './copyIntentRule';

describe('BEGIN_AGAIN_COPY', () => {
  it('exports heading, body, action, and celebration keys', () => {
    expect(typeof BEGIN_AGAIN_COPY.heading).toBe('string');
    expect(typeof BEGIN_AGAIN_COPY.body).toBe('string');
    expect(typeof BEGIN_AGAIN_COPY.action).toBe('string');
    expect(typeof BEGIN_AGAIN_COPY.celebration).toBe('string');
    expect(Object.keys(BEGIN_AGAIN_COPY).sort()).toEqual(
      ['action', 'body', 'celebration', 'heading'].sort(),
    );
  });

  it('celebration names no next stage, because at the terminal stage there is none', () => {
    expect(BEGIN_AGAIN_COPY.celebration).not.toMatch(/unlocked/i);
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

  it('celebration ranks or shames no one (intent rule, not a wordlist)', () => {
    expect(ranksOrShames(BEGIN_AGAIN_COPY.celebration)).toBe(false);
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
