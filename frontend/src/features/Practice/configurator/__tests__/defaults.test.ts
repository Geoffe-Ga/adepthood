/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import type { ModeConfig } from '../../engine/types';
import { validateModeConfig } from '../../engine/validation';
import { defaultConfigFor, suggestedDurationFor } from '../defaults';

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
