/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import {
  describeCardFacts,
  describeSettledFacts,
  describeSuggestionFacts,
} from '../suggestionFacts';

import type { CompletionSuggestion } from '@/api';
import { MAX_BACKFILL_DAYS } from '@/utils/backfillWindow';
import { DEFAULT_TIMEZONE, addDaysInTZ } from '@/utils/dateUtils';

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
  logged_on: null,
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

// #2905. The accept ran on day N and logged N; detection had read N+1.
const ACCEPT_DAY = '2026-09-12';
const DETECTED_DAY = '2026-09-13';
const after = (days: number): string => addDaysInTZ(ACCEPT_DAY, days, DEFAULT_TIMEZONE);
const ONE_DAY = 1;
const TWO_DAYS = 2;
const FORTY_DAYS = 40;
// A backfill 25 days before the accept: in window then, out of it once it ages
// past MAX_BACKFILL_DAYS.
const BACKDATE_DAYS = 25;
const BACKDATED_DAY = after(-BACKDATE_DAYS);

const settled = (o: Partial<CompletionSuggestion> = {}): CompletionSuggestion =>
  s({
    status: 'accepted',
    completed_units: 64,
    completed_on: DETECTED_DAY,
    logged_on: ACCEPT_DAY,
    ...o,
  });

describe('describeSettledFacts', () => {
  it('names the LOGGED day, not the detected one, on the day itself', () => {
    expect(describeSettledFacts(settled(), 'oz', ACCEPT_DAY)).toBe('64 oz · today');
  });

  it('reads yesterday the day after -- never "today" for the detected day', () => {
    const facts = describeSettledFacts(settled(), 'oz', after(ONE_DAY));
    expect(facts).toBe('64 oz · yesterday');
    expect(facts).not.toMatch(/today/u);
  });

  it('names the logged day as a date two days on', () => {
    expect(describeSettledFacts(settled(), 'oz', after(TWO_DAYS))).toBe('64 oz · Sat, Sep 12');
  });

  it('still names the logged day forty days on, past the backfill window', () => {
    expect(describeSettledFacts(settled(), 'oz', after(FORTY_DAYS))).toBe('64 oz · Sat, Sep 12');
  });

  it('keeps a backdated day once it has aged out of the window', () => {
    const backdated = settled({ completed_on: BACKDATED_DAY, logged_on: BACKDATED_DAY });
    const viewedOn = addDaysInTZ(BACKDATED_DAY, MAX_BACKFILL_DAYS + ONE_DAY, DEFAULT_TIMEZONE);

    expect(describeSettledFacts(backdated, 'oz', viewedOn)).toBe('64 oz · Tue, Aug 18');
  });

  it('states no day for a row with no recorded day, even when completed_on is today', () => {
    expect(
      describeSettledFacts(
        settled({ logged_on: null, completed_on: ACCEPT_DAY }),
        'oz',
        ACCEPT_DAY,
      ),
    ).toBe('64 oz');
  });

  it('returns null when there is neither an amount nor a recorded day', () => {
    expect(
      describeSettledFacts(settled({ completed_units: null, logged_on: null }), 'oz', ACCEPT_DAY),
    ).toBeNull();
  });

  it('names the day alone when no amount was stated', () => {
    expect(describeSettledFacts(settled({ completed_units: null }), null, after(ONE_DAY))).toBe(
      'yesterday',
    );
  });
});

describe('describeCardFacts', () => {
  it('routes an accepted row to the recorded day', () => {
    expect(describeCardFacts(settled(), 'oz', after(ONE_DAY))).toBe('64 oz · yesterday');
  });

  it('routes a pending row to the window-gated promise, unchanged', () => {
    // A pending offer carries no logged day; its in-window detected day is what
    // OK will log, so the pending line names THAT, exactly as before.
    const pending = s({ completed_units: 64, completed_on: ACCEPT_DAY, logged_on: null });
    expect(describeCardFacts(pending, 'oz', after(ONE_DAY))).toBe(
      describeSuggestionFacts(pending, 'oz', after(ONE_DAY)),
    );
    expect(describeCardFacts(pending, 'oz', after(ONE_DAY))).toBe('64 oz · yesterday');
  });

  it('keeps the pending window gate: a day OK would refuse is omitted', () => {
    const pending = s({ completed_units: 64, completed_on: DETECTED_DAY });
    expect(describeCardFacts(pending, 'oz', ACCEPT_DAY)).toBe('64 oz');
  });

  it('never reads logged_on for a row that is not accepted', () => {
    const dismissed = s({ status: 'dismissed', completed_units: 64, logged_on: ACCEPT_DAY });
    expect(describeCardFacts(dismissed, 'oz', ACCEPT_DAY)).toBe('64 oz');
  });
});
