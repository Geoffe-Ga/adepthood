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
import WritingSessionSurface from '../WritingSessionSurface';
import WritingTimer from '../WritingTimer';

import { SPACING, colors, journalLayout, touchTarget } from '@/design/tokens';

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
 * The timer floats alone; resonance lives in the page flow (#3004).
 *
 * The timer's wrapper is ``position: absolute`` with ``left: 0; right: 0``, so
 * it owns every touch across its band. Resonance used to float in a band of
 * its own beneath it on a phone; it now sits in the margin, in flow, so the
 * timer keeps its offset above the page's lower edge and nothing floats beside
 * it to share or fight over that band.
 */
describe('the writing timer floats in every state', () => {
  it('uses opaque paper on native where no backdrop blur protects the readout', () => {
    const timer = render(<WritingTimer onComplete={jest.fn()} />);
    expect(flat(timer.getByTestId('writing-timer-pill').props.style).backgroundColor).toBe(
      colors.paper.background,
    );
  });

  it('floats the expanded idle pill while resonance stays in flow', () => {
    const timer = render(<WritingTimer onComplete={jest.fn()} />);
    const resonance = render(<GetResonanceButton visible onPress={jest.fn()} />);

    expect(flat(timer.root.props.style).position).toBe('absolute');
    expect(flat(timer.root.props.style).bottom).toBe(RESONANCE_BUTTON_CLEARANCE);
    expect(flat(resonance.root.props.style).position).not.toBe('absolute');
  });

  it('keeps the running compact pill on the existing floating rail', () => {
    const timer = render(<WritingTimer onComplete={jest.fn()} />);
    fireEvent.press(timer.getByTestId('writing-timer-start'));

    expect(flat(timer.root.props.style).position).toBe('absolute');
    expect(flat(timer.root.props.style).bottom).toBe(RESONANCE_BUTTON_CLEARANCE);
  });

  it('lets a touch fall through its own band as well, rather than trading one trap for another', () => {
    const timer = render(<WritingTimer onComplete={jest.fn()} />);

    expect(timer.root.props.pointerEvents).toBe('box-none');
  });
});

describe('the page reserves the band the timer floats in', () => {
  it('holds room for the timer at its offset above the page edge, as one inset', () => {
    expect(WRITING_TIMER_CLEARANCE).toBeGreaterThanOrEqual(
      RESONANCE_BUTTON_CLEARANCE + touchTarget.minimum,
    );
    expect(styles.pageWithFloatingAction.paddingBottom).toBe(WRITING_TIMER_CLEARANCE);
  });
});

/**
 * The pill's minimum height from its rendered rows. Wrapped presets can grow
 * beyond this floor; WritingSessionSurface reports their actual laid-out height.
 */
function minimumPillHeight(view: ReturnType<typeof render>): number {
  const pill = flat(view.getByTestId('writing-timer-pill').props.style);
  const rows = view.getAllByTestId(/^writing-timer-row-/);
  const rowTotal = rows.reduce((sum, row) => {
    const style = flat(row.props.style);
    return sum + dp(style.height === 'auto' ? style.minHeight : style.height);
  }, 0);
  const gaps = (rows.length - 1) * dp(pill.rowGap ?? pill.gap ?? 0);
  return dp(pill.paddingVertical) * 2 + rowTotal + gaps;
}

describe('the page reserves the space the pill actually occupies', () => {
  it('reserves the idle pill minimum before its measured layout arrives', () => {
    const view = render(<WritingTimer onComplete={jest.fn()} />);

    const measured = minimumPillHeight(view);

    expect(view.getAllByTestId(/^writing-timer-row-/).length).toBeGreaterThan(1);
    expect(WRITING_TIMER_PILL_MAX_HEIGHT).toBeGreaterThanOrEqual(measured);
    expect(WRITING_TIMER_CLEARANCE).toBeGreaterThanOrEqual(RESONANCE_BUTTON_CLEARANCE + measured);
  });

  it('reserves at least the running pill too, which sheds a row', () => {
    const view = render(<WritingTimer onComplete={jest.fn()} />);
    fireEvent.press(view.getByTestId('writing-timer-start'));

    const measured = minimumPillHeight(view);

    expect(WRITING_TIMER_CLEARANCE).toBeGreaterThanOrEqual(RESONANCE_BUTTON_CLEARANCE + measured);
  });

  it('reserves reported wrapped rows beyond the static timer floor', () => {
    const onClearanceChange = jest.fn();
    const view = render(<WritingSessionSurface onClearanceChange={onClearanceChange} />);
    const wrappedHeight = WRITING_TIMER_PILL_MAX_HEIGHT + touchTarget.minimum;
    fireEvent(view.getByTestId('writing-session-band-content'), 'layout', {
      nativeEvent: { layout: { height: wrappedHeight } },
    });
    expect(onClearanceChange).toHaveBeenLastCalledWith(
      wrappedHeight + RESONANCE_BUTTON_CLEARANCE + SPACING.md,
    );
    expect(onClearanceChange.mock.calls.at(-1)?.[0]).toBeGreaterThan(WRITING_TIMER_CLEARANCE);
  });

  it('keeps readout and presets in separate rows with full touch targets', () => {
    const view = render(<WritingTimer onComplete={jest.fn()} />);
    const pill = flat(view.getByTestId('writing-timer-pill').props.style);

    expect(pill.flexDirection).toBe('column');
    expect(pill.flexWrap).not.toBe('wrap');
    // Presets can share a line or wrap; each keeps its minimum touch target.
    const preset = flat(view.getByTestId('writing-timer-preset-45').props.style);
    expect(preset.flex).toBe(1);
    expect(preset.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(preset.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
  });
});

describe('the finished-session note clears what floats over it', () => {
  it('sits above the floating timer at its offset rather than under its pill', () => {
    const result: WritingSessionResult = {
      plannedMinutes: 20,
      elapsedMs: 20 * 60_000,
      elapsedMinutes: 20,
      reachedFullDuration: true,
    };
    const view = render(<WritingSessionBanner result={result} onDismiss={jest.fn()} />);

    // The floating band handles vertical stacking; the note only owns its reading measure.
    expect(flat(view.root.props.style).maxWidth).toBe(journalLayout.pageMaxWidth);
    expect(flat(view.root.props.style).alignSelf).toBe('center');
    expect(flat(view.root.props.style).marginBottom).toBeLessThan(WRITING_TIMER_PILL_MAX_HEIGHT);
  });
});
