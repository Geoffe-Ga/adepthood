import { describe, expect, it } from '@jest/globals';
import type { ImageSourcePropType } from 'react-native';

import { resolveCardImage } from '../assetResolver';
import { RWS_CARDS } from '../decks/rws';
import { RWS_IMAGES } from '../decks/rwsImages';

const PLACEHOLDER = require('../../../../../assets/cards/_placeholder.png') as ImageSourcePropType;

const SHIPPED_KEYS = Object.keys(RWS_IMAGES);
const MAJOR_ARCANA_COUNT = 22;

describe('resolveCardImage — shipped artwork', () => {
  it('ships at least the full Major Arcana', () => {
    expect(SHIPPED_KEYS.length).toBeGreaterThanOrEqual(MAJOR_ARCANA_COUNT);
  });

  it('returns a real, non-placeholder image for every shipped key', () => {
    for (const key of SHIPPED_KEYS) {
      const resolved = resolveCardImage(key);
      expect(resolved).not.toBeNull();
      expect(resolved).not.toBe(PLACEHOLDER);
      // The resolver returns exactly the bundled require for that key.
      expect(resolved).toBe(RWS_IMAGES[key]);
    }
  });

  it('never returns the same reference for two different shipped keys', () => {
    // The bug this issue fixes: buildRwsImageMap() mapped all 78 keys to one
    // shared PLACEHOLDER require, so every draw rendered the same grey card.
    const references = SHIPPED_KEYS.map((key) => resolveCardImage(key));
    expect(new Set(references).size).toBe(SHIPPED_KEYS.length);
  });
});

describe('resolveCardImage — fallbacks', () => {
  it('returns null for a null asset_key (text-only card)', () => {
    expect(resolveCardImage(null)).toBeNull();
  });

  it('returns null for an unknown asset_key', () => {
    expect(resolveCardImage('rws/not_a_real_card')).toBeNull();
    expect(resolveCardImage('some/other_deck_key')).toBeNull();
  });

  it('returns the documented placeholder for a known-but-unshipped key', () => {
    const unshipped = RWS_CARDS.find((card) => !(card.asset_key in RWS_IMAGES));
    expect(unshipped).toBeDefined();
    expect(resolveCardImage(unshipped!.asset_key)).toBe(PLACEHOLDER);
  });

  it('covers the full 78-key RWS space (shipped image or placeholder, never null)', () => {
    for (const card of RWS_CARDS) {
      expect(resolveCardImage(card.asset_key)).not.toBeNull();
    }
  });
});
