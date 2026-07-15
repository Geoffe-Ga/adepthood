/* eslint-env jest */
/* global describe, it, expect */
import { RANK_OR_SHAME_PATTERNS, countRankOrShameMatches, ranksOrShames } from './copyIntentRule';

describe('ranksOrShames', () => {
  it.each([
    ["you're only at level 3"],
    ['you are at level 4'],
    ["you're at stage 3 of 10"],
    ['climb to unlock deeper practice'],
    ['unlock the next tier of practice'],
    ['reach the next to unlock more content'],
    ["you're behind"],
    ["don't fall behind"],
    ['catch up to the others'],
    ['leaderboard'],
    ['you hold rank 5 this week'],
    ['you are ranked among your peers'],
    ['she is ahead of you now'],
    ["you're inferior to them"],
    ['they are further along than you'],
    ['keep your streak this week'],
    ['you lost your streak'],
    ["don't lose your streak today"],
    ['keep the streak alive'],
    ['you broke your streak yesterday'],
    ["don't miss out on this moment"],
    ["don't break the chain"],
    ['this streak lasts forever'],
    ['just keep going no matter what'],
    ['you must complete this today'],
    ["don't lose your momentum"],
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

describe('RANK_OR_SHAME_PATTERNS coverage', () => {
  const SOLE_MATCH_STRINGS: readonly string[] = [
    "you're only at level 3",
    'you are at level 4',
    "you're at stage 3 of 10",
    'you hold rank 5 this week',
    'you are ranked among your peers',
    'the leaderboard resets weekly',
    'climb to unlock deeper practice',
    'unlock the next tier of practice',
    'reach the next to unlock more content',
    'left behind again today',
    'catch up to the others',
    'she is ahead of you now',
    "you're inferior to them",
    'they are further along than you',
    'keep your streak this week',
    'the streak alive tonight',
    'you lost your streak',
    'you broke your streak yesterday',
    "don't miss out on this moment",
    "don't break the chain",
    'this lasts forever now',
    'just keep going no matter what',
    'you must complete this today',
    "don't lose your momentum",
  ];

  it.each(SOLE_MATCH_STRINGS.map((copy) => [copy]))(
    'has a string matching exactly one pattern: %s',
    (copy) => {
      expect(countRankOrShameMatches(copy)).toBe(1);
    },
  );

  it('provides one sole-match string per pattern', () => {
    expect(SOLE_MATCH_STRINGS).toHaveLength(RANK_OR_SHAME_PATTERNS.length);
  });

  it('exercises every pattern via a sole-match string', () => {
    const covered = RANK_OR_SHAME_PATTERNS.map((pattern) =>
      SOLE_MATCH_STRINGS.some((copy) => pattern.test(copy)),
    );
    expect(covered.every(Boolean)).toBe(true);
  });
});
