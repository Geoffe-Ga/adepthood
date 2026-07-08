/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { promptTitleForWeek } from '../promptTitle';

describe('promptTitleForWeek', () => {
  const cases: Array<[number, string]> = [
    [1, 'Beige week 1 Prompt #1'],
    [3, 'Beige week 3 Prompt #1'],
    [4, 'Purple week 1 Prompt #1'],
    [8, 'Red week 2 Prompt #1'],
    [36, 'Ultraviolet week 3 Prompt #1'],
  ];

  it.each(cases)('week %i -> %s', (week, expected) => {
    expect(promptTitleForWeek(week)).toBe(expected);
  });
});
