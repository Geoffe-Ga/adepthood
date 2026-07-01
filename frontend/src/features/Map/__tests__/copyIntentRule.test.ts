/* eslint-env jest */
/* global describe, it, expect */
import { ranksOrShames } from './copyIntentRule';

describe('ranksOrShames', () => {
  it.each([
    ["you're only at level 3"],
    ['climb to unlock the next stage'],
    ["you're behind"],
    ["don't fall behind"],
    ['catch up to the others'],
    ['leaderboard'],
    ['keep your streak alive or lose it'],
    ['you lost your streak'],
  ])('returns true for ranking/shaming copy: %s', (copy) => {
    expect(ranksOrShames(copy)).toBe(true);
  });

  it.each([
    ['higher frequencies'],
    ['the wavelength rises'],
    ['the ascending arc of the Stages'],
    ['bring the system online'],
    ['Stage 10 / Emptiness'],
  ])('returns false for legal model vocabulary: %s', (copy) => {
    expect(ranksOrShames(copy)).toBe(false);
  });
});
