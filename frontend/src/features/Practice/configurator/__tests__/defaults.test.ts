/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import type { ModeConfig } from '../../engine/types';
import { validateModeConfig } from '../../engine/validation';
import { defaultConfigFor, isDurationDriven, suggestedDurationFor } from '../defaults';

const ALL_MODES: ReadonlyArray<ModeConfig['mode']> = [
  'meditation_timer',
  'count_up',
  'metronome',
  'interval_bell',
  'random_interval_bell',
  'rep_counter',
  'sense_grounding',
  'tallied_grounding',
  'tarot',
  'card_meditation',
  'mindful_anchor',
];

describe('defaultConfigFor', () => {
  it.each(ALL_MODES)('returns a server-valid default for %s', (mode) => {
    const config = defaultConfigFor(mode);
    expect(config.mode).toBe(mode);
    expect(validateModeConfig(config)).toEqual([]);
  });

  it('returns fresh objects each call so the wizard can mutate safely', () => {
    const a = defaultConfigFor('meditation_timer');
    const b = defaultConfigFor('meditation_timer');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe('suggestedDurationFor', () => {
  it('uses duration_minutes for duration-bearing modes', () => {
    expect(suggestedDurationFor(defaultConfigFor('meditation_timer'))).toBeGreaterThan(0);
    expect(suggestedDurationFor(defaultConfigFor('interval_bell'))).toBeGreaterThan(0);
    expect(suggestedDurationFor(defaultConfigFor('random_interval_bell'))).toBeGreaterThan(0);
  });

  it('uses the embedded timer duration for metronome', () => {
    expect(suggestedDurationFor(defaultConfigFor('metronome'))).toBeGreaterThan(0);
  });

  it('uses per_card_minutes for card-based modes', () => {
    const tarot: ModeConfig = {
      mode: 'tarot',
      deck: 'major_arcana',
      per_card_minutes: 7,
    };
    expect(suggestedDurationFor(tarot)).toBe(7);
    const card: ModeConfig = {
      mode: 'card_meditation',
      deck_id: 'rws',
      per_card_minutes: 6,
    };
    expect(suggestedDurationFor(card)).toBe(6);
  });

  it('falls back to a non-zero default for open-ended modes', () => {
    expect(suggestedDurationFor(defaultConfigFor('count_up'))).toBeGreaterThan(0);
    expect(suggestedDurationFor(defaultConfigFor('rep_counter'))).toBeGreaterThan(0);
    expect(suggestedDurationFor(defaultConfigFor('sense_grounding'))).toBeGreaterThan(0);
    expect(suggestedDurationFor(defaultConfigFor('tallied_grounding'))).toBeGreaterThan(0);
  });

  it('falls back to a default when per_card_minutes is omitted', () => {
    expect(
      suggestedDurationFor({ mode: 'tarot', deck: 'major_arcana' } satisfies ModeConfig),
    ).toBeGreaterThan(0);
    expect(
      suggestedDurationFor({
        mode: 'card_meditation',
        deck_id: 'rws',
      } satisfies ModeConfig),
    ).toBeGreaterThan(0);
  });
});

describe('isDurationDriven', () => {
  // Modes whose config carries the countdown duration — the wizard hides the
  // standalone duration field and derives default_duration_minutes from config.
  it.each(['meditation_timer', 'interval_bell', 'random_interval_bell', 'metronome'] as const)(
    'returns true for timer-family mode %s',
    (mode) => {
      expect(isDurationDriven(mode)).toBe(true);
    },
  );

  // Open-ended and step-counted modes keep the standalone duration field.
  it.each(['count_up', 'rep_counter', 'sense_grounding', 'tallied_grounding'] as const)(
    'returns false for open-ended/step-counted mode %s',
    (mode) => {
      expect(isDurationDriven(mode)).toBe(false);
    },
  );

  // Card-based modes derive duration per-card, not via the timer family.
  it.each(['tarot', 'card_meditation'] as const)('returns false for card-based mode %s', (mode) => {
    expect(isDurationDriven(mode)).toBe(false);
  });

  // mindful_anchor has a min_duration_seconds hint but is deliberately NOT
  // duration-driven — its duration field must remain user-editable.
  it('returns false for mindful_anchor despite its duration hint', () => {
    expect(isDurationDriven('mindful_anchor')).toBe(false);
  });

  // Exhaustive cross-check: exactly 4 modes are duration-driven across the
  // full 11-mode set. If a future edit adds or drops a mode the count changes.
  it('returns true for exactly 4 of the 11 modes', () => {
    const driven = ALL_MODES.filter((m) => isDurationDriven(m));
    expect(driven).toHaveLength(4);
    expect(new Set(driven)).toEqual(
      new Set(['meditation_timer', 'interval_bell', 'random_interval_bell', 'metronome']),
    );
  });
});
