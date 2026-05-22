import { describe, expect, it } from '@jest/globals';

import { formatModeSummary, type ModeSummaryMetadata } from '../format';

describe('formatModeSummary', () => {
  it.each<[ModeSummaryMetadata, number, string]>([
    [{ mode: 'meditation_timer' }, 10, '10:00 of stillness'],
    [{ mode: 'meditation_timer' }, 12 + 34 / 60, '12:34 of stillness'],
    [{ mode: 'count_up' }, 7.5, '07:30 of open practice'],
    [{ mode: 'metronome', bpm_used: 60 }, 30, 'BPM 60 for 30:00'],
    [
      { mode: 'interval_bell', intervals_struck: 3, total_intervals: 5 },
      15,
      '3/5 bells over 15:00',
    ],
    [{ mode: 'random_interval_bell', bells_struck: 6 }, 20, '6 random bells over 20:00'],
    [
      { mode: 'rep_counter', rep_count: 108, unit_label: 'breath cycles' },
      12 + 34 / 60,
      '108 breath cycles in 12:34',
    ],
    [
      { mode: 'sense_grounding', senses_completed: ['sight', 'touch', 'hearing'] },
      4,
      'Grounded through 3 senses',
    ],
    [{ mode: 'tarot', card_index: 0, card_name: 'The Fool' }, 5, 'The Fool for 05:00'],
    [{ mode: 'card_meditation', deck_id: 'rws', card_name: 'The Star' }, 5, 'The Star for 05:00'],
    [
      { mode: 'tallied_grounding', rounds_completed: 3, total_rounds: 3, items_completed: 27 },
      6,
      '27 items across 3/3 rounds',
    ],
  ])('formats %j (%s min) as %s', (metadata, durationMinutes, expected) => {
    expect(formatModeSummary(metadata.mode, durationMinutes, metadata)).toBe(expected);
  });

  it('clamps negative durations to 00:00', () => {
    expect(formatModeSummary('meditation_timer', -1, { mode: 'meditation_timer' })).toBe(
      '00:00 of stillness',
    );
  });

  it('rounds seconds down, not up', () => {
    // 59.999 seconds -> 00:59, not 01:00.
    expect(formatModeSummary('count_up', 59.999 / 60, { mode: 'count_up' })).toBe(
      '00:59 of open practice',
    );
  });

  it('renders a singular rep with the supplied unit_label unchanged', () => {
    expect(
      formatModeSummary('rep_counter', 1, {
        mode: 'rep_counter',
        rep_count: 1,
        unit_label: 'rep',
      }),
    ).toBe('1 rep in 01:00');
  });

  it('renders zero senses_completed without crashing', () => {
    expect(
      formatModeSummary('sense_grounding', 0.5, {
        mode: 'sense_grounding',
        senses_completed: [],
      }),
    ).toBe('Grounded through 0 senses');
  });

  it('throws on an unknown mode discriminator (defensive — the type system normally forbids this)', () => {
    // Cast through ``unknown`` so a future refactor that drops the
    // exhaustive switch is caught at runtime by the existing tests instead
    // of silently producing an undefined summary string.
    expect(() =>
      (formatModeSummary as unknown as (m: string, d: number, meta: { mode: string }) => string)(
        'not_a_mode',
        1,
        { mode: 'not_a_mode' },
      ),
    ).toThrow(/unhandled mode/);
  });
});
