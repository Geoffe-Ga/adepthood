import { describe, expect, it } from '@jest/globals';

import { pickCard } from '../../data/resolveCard';
import type { PickedCard } from '../../data/resolveCard';
import type {
  CardMeditationConfig,
  RandomIntervalBellConfig,
  RandomIntervalBellMetadata,
} from '../../engine/types';
import { fakeState } from '../../views/__tests__/fixtures';
import { harvestMetadata, harvestSummaryMetadata } from '../ActiveRitualSession';

const config: CardMeditationConfig = { mode: 'card_meditation', deck_id: 'rws', cards: null };

const randomBellConfig: RandomIntervalBellConfig = {
  mode: 'random_interval_bell',
  duration_minutes: 20,
  min_interval_seconds: 30,
  max_interval_seconds: 180,
  bell_tone: 'bowl',
};

describe('card_meditation metadata harvest', () => {
  it('records the same card in the wire and summary metadata', () => {
    const cardPick = pickCard(config);
    const wire = harvestMetadata(config, fakeState(), cardPick);
    const summary = harvestSummaryMetadata(config, fakeState(), 0, cardPick);
    expect(wire.mode).toBe('card_meditation');
    expect(summary.mode).toBe('card_meditation');
    // The card shown in the post-session summary must match the card
    // recorded in the wire metadata — they share one threaded draw.
    if (wire.mode === 'card_meditation' && summary.mode === 'card_meditation') {
      expect(summary.card_name).toBe(wire.card_drawn_name);
      expect(wire.card_drawn_name).toBe(cardPick.card.name);
    }
  });

  it('harvests the threaded card draw rather than reshuffling', () => {
    // An injected draw the deck would never produce: if the harvest read
    // the threaded value it surfaces here; if it re-called pickCard it would
    // not.
    const injected: PickedCard = {
      card: { name: 'Injected Card', image_asset_key: null, image_uri: null, symbolism: null },
      index: 7,
    };
    const wire = harvestMetadata(config, fakeState(), injected);
    expect(wire).toMatchObject({
      mode: 'card_meditation',
      card_drawn_name: 'Injected Card',
      card_drawn_index: 7,
    });
  });
});

describe('random_interval_bell metadata harvest', () => {
  it('falls back to an empty schedule when the view reported nothing', () => {
    const wire = harvestMetadata(randomBellConfig, fakeState(), null, null);
    expect(wire).toEqual({
      mode: 'random_interval_bell',
      bells_struck: 0,
      interval_seconds: [],
    });
    const summary = harvestSummaryMetadata(randomBellConfig, fakeState(), 0, null, null);
    expect(summary).toEqual({ mode: 'random_interval_bell', bells_struck: 0 });
  });

  it('threads the view-reported metadata into the wire and summary harvest', () => {
    const reported: RandomIntervalBellMetadata = {
      mode: 'random_interval_bell',
      bells_struck: 4,
      interval_seconds: [40, 90, 60, 120],
    };
    const wire = harvestMetadata(randomBellConfig, fakeState(), null, reported);
    expect(wire).toEqual(reported);
    const summary = harvestSummaryMetadata(randomBellConfig, fakeState(), 0, null, reported);
    expect(summary).toEqual({ mode: 'random_interval_bell', bells_struck: 4 });
  });
});
