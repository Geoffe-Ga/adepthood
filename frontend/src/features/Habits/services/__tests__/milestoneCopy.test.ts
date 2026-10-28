import { describe, expect, it } from '@jest/globals';

import { milestoneLine } from '../milestoneCopy';

describe('milestoneLine', () => {
  it('says nothing for an empty or beginning run', () => {
    expect(milestoneLine(undefined, 'Pages', 'day')).toBeNull();
    expect(milestoneLine([], 'Pages', 'day')).toBeNull();
    expect(milestoneLine([{ threshold: 1, kind: 'streak_started' }], 'Pages', 'day')).toBeNull();
    expect(milestoneLine([{ threshold: 2 }], 'Pages', 'day')).toBeNull();
  });

  it('words a run threshold in the habit cadence', () => {
    expect(milestoneLine([{ threshold: 7 }], 'Pages', 'day')).toBe('A 7-day run of Pages.');
    expect(milestoneLine([{ threshold: 3 }], 'Gym', 'week')).toBe('A 3-week run of Gym.');
    expect(milestoneLine([{ threshold: 21 }], 'Pages', 'day')).toBe(
      'Twenty-one days. One full stage of Pages.',
    );
  });

  it('prefers server copy, then a return, then a personal best, then the largest run', () => {
    expect(
      milestoneLine(
        [
          { threshold: 3, kind: 'streak_milestone' },
          { threshold: 14, kind: 'streak_milestone' },
        ],
        'Pages',
        'day',
      ),
    ).toBe('A 14-day run of Pages.');
    expect(
      milestoneLine(
        [
          { threshold: 14, kind: 'streak_milestone' },
          { threshold: 15, kind: 'personal_best' },
        ],
        'Pages',
        'day',
      ),
    ).toBe('The longest run of Pages yet: a 15-day run.');
    expect(
      milestoneLine(
        [
          { threshold: 15, kind: 'personal_best' },
          { threshold: 1, kind: 'comeback' },
        ],
        'Pages',
        'day',
      ),
    ).toBe('Back to Pages. The record kept your place.');
    expect(
      milestoneLine(
        [
          { threshold: 1, kind: 'comeback' },
          { threshold: 30, label: 'Thirty days of pages.' },
        ],
        'Pages',
        'day',
      ),
    ).toBe('Thirty days of pages.');
  });
});
