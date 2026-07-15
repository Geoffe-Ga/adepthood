import { describe, expect, it } from '@jest/globals';

import { harvestMetadata, harvestSummaryMetadata } from '../../engine/harvestMetadata';
import type {
  IntervalBellConfig,
  MeditationTimerConfig,
  MetronomeConfig,
  MindfulAnchorConfig,
  MindfulAnchorMetadata,
  RepCounterConfig,
  SenseGroundingConfig,
  TalliedGroundingConfig,
  TarotConfig,
} from '../../engine/types';
import { fakeState } from '../../views/__tests__/fixtures';

const meditationTimerConfig: MeditationTimerConfig = {
  mode: 'meditation_timer',
  duration_minutes: 10,
};

const countUpConfig = { mode: 'count_up' as const };

const metronomeConfig: MetronomeConfig = {
  mode: 'metronome',
  bpm: 72,
  timer: meditationTimerConfig,
};

const intervalBellConfig: IntervalBellConfig = {
  mode: 'interval_bell',
  duration_minutes: 10,
  interval_minutes: 2,
  bell_tone: 'chime',
};

const repCounterConfig: RepCounterConfig = {
  mode: 'rep_counter',
  target_reps: 20,
  unit_label: 'reps',
};

const senseGroundingConfig: SenseGroundingConfig = {
  mode: 'sense_grounding',
  prompts: [
    { sense: 'sight', label: 'something blue' },
    { sense: 'touch', label: 'something soft' },
  ],
};

const talliedGroundingConfig: TalliedGroundingConfig = {
  mode: 'tallied_grounding',
  rounds: 2,
  categories: [
    { key: 'square', label: 'a square', target_count: 3 },
    { key: 'circle', label: 'a circle', target_count: 2 },
  ],
};

const tarotConfig: TarotConfig = { mode: 'tarot', deck: 'major_arcana' };

const mindfulAnchorConfig: MindfulAnchorConfig = {
  mode: 'mindful_anchor',
  instruction: 'Step outside.',
  min_duration_seconds: 60,
  options: [{ key: 'touch_grass', label: 'Touch grass' }],
  require_option_choice: false,
};

describe('ActiveRitualSession harvesters — simple engine modes', () => {
  it('meditation_timer harvests a bare-mode wire and summary payload', () => {
    const wire = harvestMetadata(meditationTimerConfig, fakeState(), null);
    const summary = harvestSummaryMetadata(meditationTimerConfig, fakeState(), 0, null);
    expect(wire).toEqual({ mode: 'meditation_timer' });
    expect(summary).toEqual({ mode: 'meditation_timer' });
  });

  it('count_up harvests a bare-mode wire and summary payload', () => {
    const wire = harvestMetadata(countUpConfig, fakeState(), null);
    const summary = harvestSummaryMetadata(countUpConfig, fakeState(), 0, null);
    expect(wire).toEqual({ mode: 'count_up' });
    expect(summary).toEqual({ mode: 'count_up' });
  });

  it('metronome harvests the bpm actually used', () => {
    const wire = harvestMetadata(metronomeConfig, fakeState(), null);
    const summary = harvestSummaryMetadata(metronomeConfig, fakeState(), 0, null);
    expect(wire).toEqual({ mode: 'metronome', bpm_used: 72 });
    expect(summary).toEqual({ mode: 'metronome', bpm_used: 72 });
  });

  it('rep_counter harvests the rep count for the wire and adds unit_label for the summary', () => {
    const state = fakeState({ repCount: 14 });
    const wire = harvestMetadata(repCounterConfig, state, null);
    const summary = harvestSummaryMetadata(repCounterConfig, state, 0, null);
    expect(wire).toEqual({ mode: 'rep_counter', rep_count: 14 });
    expect(summary).toEqual({ mode: 'rep_counter', rep_count: 14, unit_label: 'reps' });
  });
});

describe('ActiveRitualSession harvesters — interval_bell', () => {
  it('counts struck intervals up to the elapsed time', () => {
    const state = fakeState({ elapsedMs: 5 * 60_000 });
    const wire = harvestMetadata(intervalBellConfig, state, null);
    const summary = harvestSummaryMetadata(intervalBellConfig, state, 0, null);
    expect(wire).toEqual({ mode: 'interval_bell', intervals_struck: 2, total_intervals: 4 });
    expect(summary).toEqual(wire);
  });
});

describe('ActiveRitualSession harvesters — sense_grounding', () => {
  it('lists only the senses completed so far', () => {
    const state = fakeState({ currentStepIndex: 1 });
    const wire = harvestMetadata(senseGroundingConfig, state, null);
    const summary = harvestSummaryMetadata(senseGroundingConfig, state, 0, null);
    expect(wire).toEqual({ mode: 'sense_grounding', senses_completed: ['sight'] });
    expect(summary).toEqual({ mode: 'sense_grounding', senses_completed: ['sight'] });
  });

  it('clamps to every prompt when currentStepIndex overruns the list', () => {
    const state = fakeState({ currentStepIndex: 99 });
    const wire = harvestMetadata(senseGroundingConfig, state, null);
    expect(wire).toEqual({ mode: 'sense_grounding', senses_completed: ['sight', 'touch'] });
  });
});

describe('ActiveRitualSession harvesters — tallied_grounding', () => {
  it('derives rounds_completed from items_completed and per-round total', () => {
    // perRound = 3 + 2 = 5; currentStepIndex 7 -> 1 full round, 7 items completed.
    const state = fakeState({ currentStepIndex: 7 });
    const wire = harvestMetadata(talliedGroundingConfig, state, null);
    expect(wire).toEqual({
      mode: 'tallied_grounding',
      rounds_completed: 1,
      total_rounds: 2,
      items_completed: 7,
    });
    // The summary harvester for tallied_grounding reuses the wire harvester verbatim.
    const summary = harvestSummaryMetadata(talliedGroundingConfig, state, 0, null);
    expect(summary).toEqual(wire);
  });

  it('clamps items_completed to the ritual total', () => {
    const state = fakeState({ currentStepIndex: 999 });
    const wire = harvestMetadata(talliedGroundingConfig, state, null);
    // Total steps = rounds(2) * perRound(5) = 10.
    expect(wire).toMatchObject({ items_completed: 10 });
  });
});

describe('ActiveRitualSession harvesters — tarot', () => {
  it('normalizes the card index modulo the deck size for both wire and summary', () => {
    const state = fakeState({ currentStepIndex: 25 });
    const wire = harvestMetadata(tarotConfig, state, null);
    const summary = harvestSummaryMetadata(tarotConfig, state, 25, null);
    expect(wire).toEqual({ mode: 'tarot', card_index: 3 });
    if (summary.mode === 'tarot') {
      expect(summary.card_index).toBe(3);
      expect(typeof summary.card_name).toBe('string');
    } else {
      throw new Error('expected tarot summary');
    }
  });

  it('wraps a negative card index into a valid deck position', () => {
    const state = fakeState({ currentStepIndex: -1 });
    const wire = harvestMetadata(tarotConfig, state, null);
    expect(wire).toEqual({ mode: 'tarot', card_index: 21 });
  });
});

describe('ActiveRitualSession harvesters — mindful_anchor', () => {
  it('falls back to the pre-save sentinel when no lifted metadata is present', () => {
    const wire = harvestMetadata(mindfulAnchorConfig, fakeState(), null, null, null);
    expect(wire).toEqual({
      mode: 'mindful_anchor',
      chosen_option_key: null,
      duration_seconds: 0,
      met_min_duration: false,
    });
    // The summary harvester for mindful_anchor is a bare-mode payload,
    // independent of the lifted metadata.
    const summary = harvestSummaryMetadata(mindfulAnchorConfig, fakeState(), 0, null);
    expect(summary).toEqual({ mode: 'mindful_anchor' });
  });

  it('threads the lifted save payload into the wire harvest', () => {
    const lifted: MindfulAnchorMetadata = {
      mode: 'mindful_anchor',
      chosen_option_key: 'touch_grass',
      duration_seconds: 75,
      met_min_duration: true,
    };
    const wire = harvestMetadata(mindfulAnchorConfig, fakeState(), null, null, lifted);
    expect(wire).toEqual(lifted);
  });
});
