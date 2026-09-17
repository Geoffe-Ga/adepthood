/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { describeSuggestionFacts } from '../suggestionFacts';

import type { CompletionSuggestion } from '@/api';

/**
 * The offer card's facts line is what turns "Check it off?" into informed
 * consent, so every branch of it is pinned here rather than through a render:
 * the formatter is pure, takes its clock as an argument, and never reaches for
 * React or the store.
 */
const s = (o: Partial<CompletionSuggestion> = {}): CompletionSuggestion => ({
  id: 7,
  journal_entry_id: 1,
  target_type: 'habit',
  goal_id: 42,
  user_practice_id: null,
  label: 'drank 64 oz of water',
  anchor_start: 0,
  anchor_end: 20,
  anchor_text: 'drank 64 oz of water',
  completed_units: null,
  completed_on: null,
  status: 'pending',
  accepted_at: null,
  created_at: '',
  updated_at: '',
  ...o,
});

describe('describeSuggestionFacts', () => {
  it('joins the amount and the day the accept will use', () => {
    expect(
      describeSuggestionFacts(
        s({ completed_units: 64, completed_on: '2026-09-11' }),
        'oz',
        '2026-09-12',
      ),
    ).toBe('64 oz · yesterday');
  });

  it('returns null when the server extracted neither fact', () => {
    expect(describeSuggestionFacts(s(), 'oz', '2026-09-12')).toBeNull();
  });

  it('omits a day the accept would refuse and silently replace with today', () => {
    // 31 days back: _in_window_day returns None and the accept logs TODAY, so
    // naming the day here would promise something pressing OK does not do.
    expect(
      describeSuggestionFacts(
        s({ completed_units: 64, completed_on: '2026-08-12' }),
        'oz',
        '2026-09-12',
      ),
    ).toBe('64 oz');
    expect(
      describeSuggestionFacts(s({ completed_on: '2026-08-12' }), 'oz', '2026-09-12'),
    ).toBeNull();
  });

  it('keeps the oldest day still inside the window', () => {
    expect(describeSuggestionFacts(s({ completed_on: '2026-08-13' }), null, '2026-09-12')).toBe(
      'Thu, Aug 13',
    );
  });

  it('omits a future day, which the accept also refuses', () => {
    expect(
      describeSuggestionFacts(
        s({ completed_units: 3, completed_on: '2026-09-13' }),
        'times',
        '2026-09-12',
      ),
    ).toBe('3 times');
  });

  it('renders a float without a trailing .0 and drops an unknown unit', () => {
    expect(describeSuggestionFacts(s({ completed_units: 1.5 }), 'oz', '2026-09-12')).toBe('1.5 oz');
    expect(describeSuggestionFacts(s({ completed_units: 64 }), null, '2026-09-12')).toBe('64');
  });

  it('names today, yesterday, and any other in-window day the repo way', () => {
    expect(describeSuggestionFacts(s({ completed_on: '2026-09-12' }), null, '2026-09-12')).toBe(
      'today',
    );
    expect(describeSuggestionFacts(s({ completed_on: '2026-09-11' }), null, '2026-09-12')).toBe(
      'yesterday',
    );
    expect(describeSuggestionFacts(s({ completed_on: '2026-09-07' }), null, '2026-09-12')).toBe(
      'Mon, Sep 7',
    );
  });

  it('states the amount alone when the goal unit has not loaded yet', () => {
    expect(
      describeSuggestionFacts(
        s({ completed_units: 3, completed_on: '2026-09-11' }),
        null,
        '2026-09-12',
      ),
    ).toBe('3 · yesterday');
  });
});
