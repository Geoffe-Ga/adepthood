import { describe, it, expect } from '@jest/globals';
import { StyleSheet } from 'react-native';

/**
 * Pins the raised reflection card's two header faces (#2862): the care note opts
 * into the shorter ``heading`` + soft ``careBody``, while ``header`` keeps the
 * title face every other reflection card (ContractionReflectionNote) relies on.
 */
import { reflectionCardStyles } from '../noteCards';

import { editorialType, ink, touchTarget } from '@/design/tokens';

describe('reflectionCardStyles', () => {
  it('keeps header at the title face so other reflection cards are unchanged', () => {
    const header = StyleSheet.flatten(reflectionCardStyles.header);
    expect(header.fontSize).toBe(editorialType.title.fontSize);
    expect(header.color).toBe(ink.primary);
  });

  it('offers a heading-size header padded clear of a top-right close X', () => {
    const heading = StyleSheet.flatten(reflectionCardStyles.heading);
    expect(heading.fontSize).toBe(editorialType.heading.fontSize);
    expect(heading.color).toBe(ink.primary);
    expect(heading.paddingRight).toBe(touchTarget.minimum);
  });

  it('sets the care body in the soft note face', () => {
    const body = StyleSheet.flatten(reflectionCardStyles.careBody);
    expect(body.fontSize).toBe(editorialType.note.fontSize);
    expect(body.color).toBe(ink.soft);
  });
});
