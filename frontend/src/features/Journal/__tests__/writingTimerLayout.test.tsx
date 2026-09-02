/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import GetResonanceButton from '../GetResonanceButton';
import styles, {
  RESONANCE_BUTTON_CLEARANCE,
  WRITING_TIMER_CLEARANCE,
  WRITING_TIMER_PILL_MAX_HEIGHT,
} from '../JournalEntry.styles';
import type { WritingSessionResult } from '../writingSession';
import WritingSessionBanner from '../WritingSessionBanner';
import WritingTimer from '../WritingTimer';

import { touchTarget } from '@/design/tokens';

function flat(style: StyleProp<ViewStyle>): ViewStyle {
  return StyleSheet.flatten(style);
}

/**
 * A style value the measurement depends on, narrowed to real dp.
 *
 * Anything percentage-based, animated or absent means the pill's height is not
 * a number this test can know — and a measurement that quietly coerced such a
 * value would be back to assuming.
 */
function dp(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError(`expected a dp number for the pill's geometry, got ${String(value)}`);
  }
  return value;
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

/**
 * The pill's height, measured from what it actually renders.
 *
 * Read off the rows the component put on screen and the style values those
 * rows actually carry — never a number remembered from when the layout was
 * designed. That is the whole point: the first version of this reserved one
 * 44dp row for a pill that really occupied two or three, and no assertion
 * noticed, because the assertion had been told the answer instead of asking.
 */
function measurePillHeight(view: ReturnType<typeof render>): number {
  const pill = flat(view.getByTestId('writing-timer-pill').props.style);
  const rows = view.getAllByTestId(/^writing-timer-row-/);
  const heights = rows.map((row) => flat(row.props.style).height);
  for (const height of heights) {
    // A row without a fixed dp height makes the pill's height a function of the
    // phone's width, which is exactly the state this guards against.
    expect(typeof height).toBe('number');
  }
  const rowTotal = heights.reduce<number>((sum, height) => sum + dp(height), 0);
  const gaps = (rows.length - 1) * dp(pill.rowGap ?? pill.gap ?? 0);
  return dp(pill.paddingVertical) * 2 + rowTotal + gaps;
}

describe('the page reserves the space the pill actually occupies', () => {
  it('reserves at least the idle pill, which is the tallest it ever gets', () => {
    const view = render(<WritingTimer onComplete={jest.fn()} />);

    const measured = measurePillHeight(view);

    expect(view.getAllByTestId(/^writing-timer-row-/).length).toBeGreaterThan(1);
    expect(WRITING_TIMER_PILL_MAX_HEIGHT).toBeGreaterThanOrEqual(measured);
    expect(WRITING_TIMER_CLEARANCE).toBeGreaterThanOrEqual(RESONANCE_BUTTON_CLEARANCE + measured);
  });

  it('reserves at least the running pill too, which sheds a row', () => {
    const view = render(<WritingTimer onComplete={jest.fn()} />);
    fireEvent.press(view.getByTestId('writing-timer-start'));

    const measured = measurePillHeight(view);

    expect(WRITING_TIMER_CLEARANCE).toBeGreaterThanOrEqual(RESONANCE_BUTTON_CLEARANCE + measured);
  });

  /**
   * Height is a count of rows only while the pill cannot reflow. A wrapping
   * row of chips is what made the shipped version two or three rows tall on
   * every phone while the page reserved one.
   */
  it('cannot reflow onto rows nobody counted', () => {
    const view = render(<WritingTimer onComplete={jest.fn()} />);
    const pill = flat(view.getByTestId('writing-timer-pill').props.style);

    expect(pill.flexDirection).toBe('column');
    expect(pill.flexWrap).not.toBe('wrap');
    // Presets share their row's width rather than demanding their own, so four
    // of them compress on a narrow phone instead of pushing past the screen.
    expect(flat(view.getByTestId('writing-timer-preset-45').props.style).flex).toBe(1);
  });
});

describe('the finished-session note clears what floats over it', () => {
  it('sits above the whole floating stack rather than under the resonance button', () => {
    const result: WritingSessionResult = {
      plannedMinutes: 20,
      elapsedMs: 20 * 60_000,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    };
    const view = render(<WritingSessionBanner result={result} onDismiss={jest.fn()} />);

    // The note is an in-flow box at the bottom of the same column the two
    // affordances float over; without this it is the Close target that ends up
    // underneath an opaque button, and the offers a later lane hangs in its
    // children slot with it.
    expect(flat(view.root.props.style).marginBottom).toBeGreaterThanOrEqual(
      RESONANCE_BUTTON_CLEARANCE + WRITING_TIMER_PILL_MAX_HEIGHT,
    );
  });
});
