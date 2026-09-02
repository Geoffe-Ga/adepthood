/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import GetResonanceButton from '../GetResonanceButton';
import styles, {
  RESONANCE_BUTTON_CLEARANCE,
  WRITING_TIMER_CLEARANCE,
} from '../JournalEntry.styles';
import WritingTimer from '../WritingTimer';

import { touchTarget } from '@/design/tokens';

function flat(style: StyleProp<ViewStyle>): ViewStyle {
  return StyleSheet.flatten(style);
}

/**
 * The two floating affordances stack; they do not share a row.
 *
 * Both wrappers are ``position: absolute`` with ``left: 0; right: 0``, so
 * "opposite sides of the same band" is still the same band — whichever one
 * paints on top owns every touch across the full width. Giving them different
 * offsets is what makes them independently reachable, and this pins that
 * offset rather than trusting it to a stylesheet nobody rereads.
 */
describe('the writing timer clears the resonance button', () => {
  it('floats a full touch target above the band the resonance button occupies', () => {
    const timer = render(<WritingTimer onComplete={jest.fn()} />);
    const resonance = render(<GetResonanceButton visible onPress={jest.fn()} />);

    const timerBottom = flat(timer.root.props.style).bottom as number;
    const resonanceBottom = flat(resonance.root.props.style).bottom as number;

    expect(flat(timer.root.props.style).position).toBe('absolute');
    expect(timerBottom).toBeGreaterThanOrEqual(resonanceBottom + touchTarget.minimum);
  });

  it('lets a touch fall through its own band as well, rather than trading one trap for another', () => {
    const timer = render(<WritingTimer onComplete={jest.fn()} />);

    expect(timer.root.props.pointerEvents).toBe('box-none');
  });
});

describe('the page reserves the band both affordances float in', () => {
  it('holds room for the timer above the resonance button, as one inset rather than two', () => {
    expect(WRITING_TIMER_CLEARANCE).toBeGreaterThanOrEqual(
      RESONANCE_BUTTON_CLEARANCE + touchTarget.minimum,
    );
    expect(styles.pageWithFloatingAction.paddingBottom).toBe(WRITING_TIMER_CLEARANCE);
  });
});
