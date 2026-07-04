/* eslint-env jest */
/* global describe, it, expect */
import { ranksOrShames } from './copyIntentRule';

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
