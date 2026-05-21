import { describe, expect, it } from '@jest/globals';

import type {
  CardMeditationConfig,
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  RepCounterConfig,
  SenseGroundingConfig,
  TarotConfig,
} from '../types';
import { CARD_MEDITATION_CARDS_MAX, CARD_MEDITATION_NAME_MAX } from '../types';
import {
  BPM_MAX,
  BPM_MIN,
  CUSTOM_NAME_MAX,
  DURATION_MAX_MINUTES,
  DURATION_MIN_MINUTES,
  PROMPT_LABEL_MAX,
  UNIT_LABEL_MAX,
  validateCountUp,
  validateCustomName,
  validateIntervalBell,
  validateMeditationTimer,
  validateMetronome,
  validateModeConfig,
  validateRepCounter,
  validateCardMeditation,
  validateSenseGrounding,
  validateTarot,
} from '../validation';

describe('validateMeditationTimer', () => {
  const base: MeditationTimerConfig = {
    mode: 'meditation_timer',
    duration_minutes: 10,
  };

  it('accepts a valid duration', () => {
    expect(validateMeditationTimer(base)).toEqual([]);
  });

  it('rejects durations below 0.5', () => {
    expect(validateMeditationTimer({ ...base, duration_minutes: 0 })).toHaveLength(1);
    expect(validateMeditationTimer({ ...base, duration_minutes: 0.4 })[0]).toMatch(/Duration/);
  });

  it('rejects durations above 24h', () => {
    expect(
      validateMeditationTimer({ ...base, duration_minutes: DURATION_MAX_MINUTES + 1 }),
    ).toHaveLength(1);
  });

  it('rejects non-finite durations', () => {
    expect(validateMeditationTimer({ ...base, duration_minutes: Number.NaN })).toHaveLength(1);
  });

  it('accepts the exact 0.5 boundary', () => {
    expect(validateMeditationTimer({ ...base, duration_minutes: DURATION_MIN_MINUTES })).toEqual(
      [],
    );
  });
});

describe('validateCountUp', () => {
  it('accepts null soft cap', () => {
    expect(validateCountUp({ mode: 'count_up', soft_cap_minutes: null })).toEqual([]);
  });

  it('accepts omitted soft cap', () => {
    expect(validateCountUp({ mode: 'count_up' })).toEqual([]);
  });

  it('rejects negative soft cap', () => {
    expect(validateCountUp({ mode: 'count_up', soft_cap_minutes: -1 })).toHaveLength(1);
  });
});

describe('validateMetronome', () => {
  const base: MetronomeConfig = {
    mode: 'metronome',
    bpm: 60,
    timer: { mode: 'meditation_timer', duration_minutes: 10 },
  };

  it('accepts a valid metronome', () => {
    expect(validateMetronome(base)).toEqual([]);
  });

  it('rejects BPM below the floor', () => {
    expect(validateMetronome({ ...base, bpm: BPM_MIN - 1 })[0]).toMatch(/BPM/);
  });

  it('rejects BPM above the ceiling', () => {
    expect(validateMetronome({ ...base, bpm: BPM_MAX + 1 })[0]).toMatch(/BPM/);
  });

  it('rejects non-integer BPM', () => {
    const errors = validateMetronome({ ...base, bpm: 60.5 });
    expect(errors.some((e) => e.includes('whole'))).toBe(true);
  });

  it('aggregates inner-timer errors', () => {
    expect(
      validateMetronome({ ...base, timer: { mode: 'meditation_timer', duration_minutes: 0 } }),
    ).toHaveLength(1);
  });
});

describe('validateIntervalBell', () => {
  const evenBase: IntervalBellConfig = {
    mode: 'interval_bell',
    duration_minutes: 20,
    interval_minutes: 5,
    cue_offsets_minutes: null,
    bell_tone: 'bowl',
  };

  it('accepts even-interval config', () => {
    expect(validateIntervalBell(evenBase)).toEqual([]);
  });

  it('rejects interval ≥ duration', () => {
    expect(validateIntervalBell({ ...evenBase, interval_minutes: 20 })[0]).toMatch(/less than/);
  });

  it('rejects setting both interval and offsets with a "not both" message', () => {
    expect(validateIntervalBell({ ...evenBase, cue_offsets_minutes: [5] })[0]).toMatch(/not both/i);
  });

  it('rejects setting neither interval nor offsets with a "select one" message', () => {
    expect(
      validateIntervalBell({
        ...evenBase,
        interval_minutes: null,
        cue_offsets_minutes: null,
      })[0],
    ).toMatch(/select/i);
  });

  it('accepts custom offsets within duration', () => {
    expect(
      validateIntervalBell({
        ...evenBase,
        interval_minutes: null,
        cue_offsets_minutes: [3, 7, 12],
      }),
    ).toEqual([]);
  });

  it('rejects offsets outside (0, duration]', () => {
    expect(
      validateIntervalBell({
        ...evenBase,
        interval_minutes: null,
        cue_offsets_minutes: [0, 30],
      })[0],
    ).toMatch(/within/);
  });

  it('rejects empty offset list', () => {
    expect(
      validateIntervalBell({
        ...evenBase,
        interval_minutes: null,
        cue_offsets_minutes: [],
      })[0],
    ).toMatch(/At least one/);
  });

  it('rejects unknown bell tone', () => {
    const errors = validateIntervalBell({
      ...evenBase,
      bell_tone: 'kazoo' as IntervalBellConfig['bell_tone'],
    });
    expect(errors.some((e) => e.includes('Unknown bell tone'))).toBe(true);
  });
});

describe('validateRepCounter', () => {
  const base: RepCounterConfig = {
    mode: 'rep_counter',
    target_reps: 108,
    unit_label: 'breaths',
    time_cap_minutes: null,
  };

  it('accepts a valid rep counter', () => {
    expect(validateRepCounter(base)).toEqual([]);
  });

  it('rejects zero reps', () => {
    expect(validateRepCounter({ ...base, target_reps: 0 })[0]).toMatch(/Target reps/);
  });

  it('rejects fractional reps', () => {
    expect(validateRepCounter({ ...base, target_reps: 1.5 })[0]).toMatch(/whole/);
  });

  it('rejects blank unit label', () => {
    expect(validateRepCounter({ ...base, unit_label: '   ' })[0]).toMatch(/Unit label/);
  });

  it('rejects oversize unit label', () => {
    expect(validateRepCounter({ ...base, unit_label: 'a'.repeat(UNIT_LABEL_MAX + 1) })[0]).toMatch(
      new RegExp(`≤ ${UNIT_LABEL_MAX}`),
    );
  });

  it('validates the optional time cap', () => {
    expect(validateRepCounter({ ...base, time_cap_minutes: -1 })).toHaveLength(1);
    expect(validateRepCounter({ ...base, time_cap_minutes: 30 })).toEqual([]);
  });
});

describe('validateSenseGrounding', () => {
  const base: SenseGroundingConfig = {
    mode: 'sense_grounding',
    prompts: [{ sense: 'sight', label: 'Notice 5 colours' }],
  };

  it('accepts a valid sequence', () => {
    expect(validateSenseGrounding(base)).toEqual([]);
  });

  it('rejects empty prompts', () => {
    expect(validateSenseGrounding({ ...base, prompts: [] })[0]).toMatch(/At least one/);
  });

  it('rejects blank labels', () => {
    expect(
      validateSenseGrounding({ ...base, prompts: [{ sense: 'sight', label: '  ' }] })[0],
    ).toMatch(/empty/);
  });

  it('rejects oversize labels', () => {
    expect(
      validateSenseGrounding({
        ...base,
        prompts: [{ sense: 'sight', label: 'x'.repeat(PROMPT_LABEL_MAX + 1) }],
      })[0],
    ).toMatch(new RegExp(`≤ ${PROMPT_LABEL_MAX}`));
  });

  it('rejects unknown sense literals', () => {
    expect(
      validateSenseGrounding({
        ...base,
        prompts: [
          { sense: 'aura' as SenseGroundingConfig['prompts'][number]['sense'], label: 'x' },
        ],
      })[0],
    ).toMatch(/unknown sense/);
  });
});

describe('validateTarot', () => {
  const base: TarotConfig = {
    mode: 'tarot',
    deck: 'major_arcana',
    per_card_minutes: 5,
    hide_timer_during_meditation: true,
  };

  it('accepts a valid tarot config', () => {
    expect(validateTarot(base)).toEqual([]);
  });

  it('rejects per-card minutes outside range', () => {
    expect(validateTarot({ ...base, per_card_minutes: 0 })).toHaveLength(1);
    expect(validateTarot({ ...base, per_card_minutes: DURATION_MAX_MINUTES + 1 })).toHaveLength(1);
  });

  it('omits per_card_minutes check when undefined', () => {
    const partial: TarotConfig = { mode: 'tarot', deck: 'major_arcana' };
    expect(validateTarot(partial)).toEqual([]);
  });
});

describe('validateCardMeditation', () => {
  const bundled: CardMeditationConfig = {
    mode: 'card_meditation',
    deck_id: 'rws',
    cards: null,
    per_card_minutes: 5,
  };

  it('accepts a valid bundled-deck config', () => {
    expect(validateCardMeditation(bundled)).toEqual([]);
  });

  it('rejects per-card minutes outside range', () => {
    expect(validateCardMeditation({ ...bundled, per_card_minutes: 0 })).toHaveLength(1);
  });

  it('rejects an invalid deck id', () => {
    expect(validateCardMeditation({ ...bundled, deck_id: 'Bad Deck' })[0]).toMatch(/deck id/i);
  });

  it('rejects a custom deck with no cards', () => {
    const empty: CardMeditationConfig = { mode: 'card_meditation', deck_id: 'custom', cards: [] };
    expect(validateCardMeditation(empty)[0]).toMatch(/at least one card/i);
    expect(validateCardMeditation({ ...empty, cards: null })[0]).toMatch(/at least one card/i);
  });

  it('accepts a custom deck with a valid card', () => {
    const config: CardMeditationConfig = {
      mode: 'card_meditation',
      deck_id: 'custom',
      cards: [{ name: 'Sunrise', image_asset_key: null, image_uri: null, symbolism: null }],
    };
    expect(validateCardMeditation(config)).toEqual([]);
  });

  it('rejects a custom card with an empty name', () => {
    const config: CardMeditationConfig = {
      mode: 'card_meditation',
      deck_id: 'custom',
      cards: [{ name: '  ', image_asset_key: null, image_uri: null, symbolism: null }],
    };
    expect(validateCardMeditation(config)[0]).toMatch(/name cannot be empty/i);
  });

  it('rejects a custom card that sets two image sources', () => {
    const config: CardMeditationConfig = {
      mode: 'card_meditation',
      deck_id: 'custom',
      cards: [
        { name: 'Both', image_asset_key: 'rws/the_fool', image_uri: 'file:///x', symbolism: null },
      ],
    };
    expect(validateCardMeditation(config)[0]).toMatch(/at most one image/i);
  });

  it('rejects a custom card with an oversize name', () => {
    const config: CardMeditationConfig = {
      mode: 'card_meditation',
      deck_id: 'custom',
      cards: [
        {
          name: 'x'.repeat(CARD_MEDITATION_NAME_MAX + 1),
          image_asset_key: null,
          image_uri: null,
          symbolism: null,
        },
      ],
    };
    expect(validateCardMeditation(config).some((e) => /≤/.test(e))).toBe(true);
  });

  it('rejects a custom deck above the card cap', () => {
    const card = { name: 'c', image_asset_key: null, image_uri: null, symbolism: null };
    const config: CardMeditationConfig = {
      mode: 'card_meditation',
      deck_id: 'custom',
      cards: Array.from({ length: CARD_MEDITATION_CARDS_MAX + 1 }, () => card),
    };
    expect(validateCardMeditation(config).some((e) => /at most/.test(e))).toBe(true);
  });
});

describe('validateCustomName', () => {
  it('accepts a normal name', () => {
    expect(validateCustomName('My Morning Sit')).toEqual([]);
  });

  it('rejects an empty/whitespace-only name', () => {
    expect(validateCustomName('')[0]).toMatch(/empty/i);
    expect(validateCustomName('   ')[0]).toMatch(/empty/i);
  });

  it('rejects oversize names', () => {
    expect(validateCustomName('x'.repeat(CUSTOM_NAME_MAX + 1))[0]).toMatch(
      new RegExp(`≤ ${CUSTOM_NAME_MAX}`),
    );
  });

  it('accepts a name at the exact length boundary', () => {
    expect(validateCustomName('x'.repeat(CUSTOM_NAME_MAX))).toEqual([]);
  });
});

describe('validateModeConfig dispatch', () => {
  it('routes by discriminator for each mode', () => {
    expect(validateModeConfig({ mode: 'meditation_timer', duration_minutes: 10 })).toEqual([]);
    expect(validateModeConfig({ mode: 'count_up' })).toEqual([]);
    expect(
      validateModeConfig({
        mode: 'metronome',
        bpm: 60,
        timer: { mode: 'meditation_timer', duration_minutes: 10 },
      }),
    ).toEqual([]);
    expect(
      validateModeConfig({
        mode: 'interval_bell',
        duration_minutes: 20,
        interval_minutes: 5,
        cue_offsets_minutes: null,
        bell_tone: 'bowl',
      }),
    ).toEqual([]);
    expect(
      validateModeConfig({
        mode: 'rep_counter',
        target_reps: 10,
        unit_label: 'reps',
      }),
    ).toEqual([]);
    expect(
      validateModeConfig({
        mode: 'sense_grounding',
        prompts: [{ sense: 'taste', label: '1 thing' }],
      }),
    ).toEqual([]);
    expect(
      validateModeConfig({
        mode: 'tarot',
        deck: 'major_arcana',
        per_card_minutes: 5,
      }),
    ).toEqual([]);
    expect(
      validateModeConfig({
        mode: 'card_meditation',
        deck_id: 'rws',
        cards: null,
      }),
    ).toEqual([]);
  });
});
