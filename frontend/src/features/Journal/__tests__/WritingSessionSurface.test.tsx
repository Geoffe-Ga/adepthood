/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import {
  RESONANCE_BUTTON_CLEARANCE,
  WRITING_BAND_LOWERED_CLEARANCE,
  WRITING_TIMER_CLEARANCE,
} from '../JournalEntry.styles';
import { DEFAULT_WRITING_MINUTES, type WritingSessionResult } from '../writingSession';
import WritingSessionSurface from '../WritingSessionSurface';

import { SPACING } from '@/design/tokens';
import type { IntervalHandle } from '@/features/Practice/engine/types';
import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

const TICK_MS = 100;
const T0 = 1_700_000_000_000;
const SHORT_PRESET_MINUTES = 10;

function renderSurface() {
  return render(
    <WritingSessionSurface
      deps={{
        now: () => Date.now(),
        setIntervalMs: (cb: () => void, ms: number): IntervalHandle => setInterval(cb, ms),
        clearIntervalMs: (handle: IntervalHandle): void => {
          clearInterval(handle);
        },
      }}
    />,
  );
}

function tickTo(atMs: number): void {
  jest.setSystemTime(atMs);
  act(() => {
    jest.advanceTimersByTime(TICK_MS);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('WritingSessionSurface', () => {
  it('docks an untouched phone timer below the paper, then restores the running overlay', () => {
    const rn = require('react-native');
    const dimensions = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const onClearanceChange = jest.fn();
    const onIdleDockHeightChange = jest.fn();
    let unmount: (() => void) | undefined;
    try {
      const view = render(
        <WritingSessionSurface
          onClearanceChange={onClearanceChange}
          onIdleDockHeightChange={onIdleDockHeightChange}
        />,
      );
      unmount = view.unmount;
      const { getByTestId } = view;
      expect(StyleSheet.flatten(getByTestId('writing-session-band').props.style)).toMatchObject({
        position: 'absolute',
        top: 'auto',
        bottom: 0,
      });
      expect(onClearanceChange).toHaveBeenLastCalledWith(0);

      fireEvent(getByTestId('writing-session-band-content'), 'layout', {
        nativeEvent: { layout: { height: 100 } },
      });
      expect(onIdleDockHeightChange).toHaveBeenLastCalledWith(100 + SPACING.md);
      fireEvent.press(getByTestId('writing-timer-start'));

      expect(StyleSheet.flatten(getByTestId('writing-session-band').props.style).position).toBe(
        'absolute',
      );
      expect(onClearanceChange).toHaveBeenLastCalledWith(WRITING_TIMER_CLEARANCE);
      expect(onIdleDockHeightChange).toHaveBeenLastCalledWith(0);
      expect(getByTestId('writing-timer-stop')).toBeTruthy();
    } finally {
      unmount?.();
      dimensions.mockRestore();
    }
  });

  it('carries the timer and no note until a session has actually finished', () => {
    const { queryByTestId } = renderSurface();

    expect(queryByTestId('writing-timer-readout')).not.toBeNull();
    expect(queryByTestId('writing-session-banner')).toBeNull();
  });

  it('notes a session that ran its whole length', () => {
    const { getByTestId, getByText } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getByTestId('writing-session-banner')).toBeTruthy();
    expect(getByText('You wrote for 20 minutes.')).toBeTruthy();
  });

  /**
   * Stopping is the writer saying they are done. Marking that with a note would
   * be the page remarking on a choice it was not asked about — the elapsed time
   * is still reported to whatever consumes the session, just not back at them.
   */
  it('says nothing at all about a session the writer stopped early', () => {
    const { getByTestId, queryByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(T0 + 12 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(queryByTestId('writing-session-banner')).toBeNull();
  });

  it('puts the note away in one tap and leaves the restart timer collapsed', () => {
    const { getByTestId, queryByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-session-banner-dismiss'));

    expect(queryByTestId('writing-session-banner')).toBeNull();
    expect(getByTestId('writing-timer-readout').props.children).toBe('20:00');
    expect(queryByTestId('writing-timer-start')).toBeNull();
    expect(queryByTestId('writing-timer-compact')).not.toBeNull();
  });

  it('keeps the note inside one floating band when the idle timer expands', () => {
    const { getByTestId } = renderSurface();
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-compact'));
    expect(StyleSheet.flatten(getByTestId('writing-session-band').props.style).position).toBe(
      'absolute',
    );
    expect(StyleSheet.flatten(getByTestId('writing-session-band').props.style).bottom).toBe(
      RESONANCE_BUTTON_CLEARANCE,
    );
    expect(
      StyleSheet.flatten(getByTestId('writing-session-banner').props.style).marginBottom,
    ).toBeLessThan(RESONANCE_BUTTON_CLEARANCE);
  });

  it('reserves the measured note and timer band without shrinking the sheet', () => {
    const onClearanceChange = jest.fn();
    const { getByTestId } = render(<WritingSessionSurface onClearanceChange={onClearanceChange} />);
    fireEvent(getByTestId('writing-session-band-content'), 'layout', {
      nativeEvent: { layout: { height: 400 } },
    });
    expect(onClearanceChange).toHaveBeenLastCalledWith(
      400 + RESONANCE_BUTTON_CLEARANCE + SPACING.md,
    );
    fireEvent(getByTestId('writing-session-band-content'), 'layout', {
      nativeEvent: { layout: { height: 40 } },
    });
    expect(onClearanceChange).toHaveBeenLastCalledWith(WRITING_TIMER_CLEARANCE);
  });

  it('uses natural content height to scroll an intermediate surface and reserves its visible height', () => {
    const onClearanceChange = jest.fn();
    const { getByTestId } = render(<WritingSessionSurface onClearanceChange={onClearanceChange} />);
    fireEvent(getByTestId('writing-session-band-content'), 'layout', {
      nativeEvent: { layout: { height: 54 } },
    });
    expect(onClearanceChange).toHaveBeenLastCalledWith(WRITING_TIMER_CLEARANCE);
    fireEvent(getByTestId('writing-session-band-content'), 'contentSizeChange', 1280, 260);
    fireEvent(getByTestId('writing-session-band'), 'layout', {
      nativeEvent: { layout: { height: 172 } },
    });
    expect(getByTestId('writing-session-band-content').props.scrollEnabled).toBe(true);
    // Content that overflows even a lowered band still lowers it, and the page
    // reserves the band where it now sits.
    expect(onClearanceChange).toHaveBeenLastCalledWith(
      54 + WRITING_BAND_LOWERED_CLEARANCE + SPACING.md,
    );
    fireEvent(getByTestId('writing-session-band-content'), 'layout', {
      nativeEvent: { layout: { height: 87 } },
    });
    expect(onClearanceChange).toHaveBeenLastCalledWith(
      87 + WRITING_BAND_LOWERED_CLEARANCE + SPACING.md,
    );
  });

  /**
   * At 200% zoom on a phone the idle timer's presets wrap to a second row, and
   * the lifted band is too short to show it (#3403). The band gives up its
   * resonance-sized lift, which nothing floats in any more, before it hides a
   * preset behind an inner scroll.
   */
  it('lowers the band to its page-edge gap when its content cannot fit above the lift', () => {
    const onClearanceChange = jest.fn();
    const { getByTestId } = render(<WritingSessionSurface onClearanceChange={onClearanceChange} />);
    const band = () => getByTestId('writing-session-band');
    const content = () => getByTestId('writing-session-band-content');
    const bottom = () => StyleSheet.flatten(band().props.style).bottom;
    const liftGiven = RESONANCE_BUTTON_CLEARANCE - WRITING_BAND_LOWERED_CLEARANCE;
    const presetsHeight = 154;
    const liftedHeight = 103;

    fireEvent(content(), 'contentSizeChange', 195, presetsHeight);
    fireEvent(band(), 'layout', { nativeEvent: { layout: { height: liftedHeight } } });
    expect(bottom()).toBe(WRITING_BAND_LOWERED_CLEARANCE);

    // Re-measured where it now sits, the band holds its content without
    // scrolling, and stays lowered rather than flipping back up.
    fireEvent(band(), 'layout', {
      nativeEvent: { layout: { height: liftedHeight + liftGiven } },
    });
    expect(bottom()).toBe(WRITING_BAND_LOWERED_CLEARANCE);
    expect(content().props.scrollEnabled).toBe(false);
    // The page reserves the band's measured height above the lowered gap, not the lift.
    fireEvent(content(), 'layout', { nativeEvent: { layout: { height: 2 * presetsHeight } } });
    expect(onClearanceChange).toHaveBeenLastCalledWith(
      2 * presetsHeight + WRITING_BAND_LOWERED_CLEARANCE + SPACING.md,
    );

    // A taller page has room above the lift again, so the band goes back up.
    fireEvent(band(), 'layout', { nativeEvent: { layout: { height: 400 } } });
    expect(bottom()).toBe(RESONANCE_BUTTON_CLEARANCE);
    expect(content().props.scrollEnabled).toBe(false);
  });

  it('keeps the lift while the content fits above it', () => {
    const { getByTestId } = renderSurface();
    fireEvent(getByTestId('writing-session-band-content'), 'contentSizeChange', 390, 100);
    fireEvent(getByTestId('writing-session-band'), 'layout', {
      nativeEvent: { layout: { height: 100 } },
    });
    expect(StyleSheet.flatten(getByTestId('writing-session-band').props.style).bottom).toBe(
      RESONANCE_BUTTON_CLEARANCE,
    );
  });

  it('hands offer scrolling to the outer surface only while measured content overflows', () => {
    const { getByTestId } = renderSurface();
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    fireEvent(getByTestId('writing-session-band-content'), 'contentSizeChange', 1280, 260);
    for (const [height, outerScrolls] of [
      [400, false],
      [172, true],
      [400, false],
    ] as const) {
      fireEvent(getByTestId('writing-session-band'), 'layout', {
        nativeEvent: { layout: { height } },
      });
      expect(getByTestId('writing-session-band-content').props.scrollEnabled).toBe(outerScrolls);
      expect(getByTestId('writing-session-offer-scroll').props.scrollEnabled).toBe(!outerScrolls);
      expect(StyleSheet.flatten(getByTestId('writing-session-banner').props.style).flexShrink).toBe(
        outerScrolls ? 0 : 1,
      );
      expect(
        StyleSheet.flatten(getByTestId('writing-session-offer-scroll').props.style).flexShrink,
      ).toBe(outerScrolls ? 0 : 1);
    }
  });

  it('keeps a running timer alive when resizing into and out of a short band', () => {
    const { getByTestId, queryByTestId } = renderSurface();
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + 5 * MS_PER_MINUTE);
    expect(getByTestId('writing-timer-readout').props.children).toBe('14:59');
    for (const height of [87, 212]) {
      fireEvent(getByTestId('writing-session-band'), 'layout', {
        nativeEvent: { layout: { height } },
      });
      expect(getByTestId('writing-timer-readout').props.children).toBe('14:59');
      expect(queryByTestId('writing-timer-stop')).not.toBeNull();
    }
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    expect(getByTestId('writing-session-banner')).toBeTruthy();
    fireEvent(getByTestId('writing-session-band'), 'layout', {
      nativeEvent: { layout: { height: 87 } },
    });
    fireEvent.press(getByTestId('writing-session-banner-dismiss'));
    expect(queryByTestId('writing-session-banner')).toBeNull();
  });

  it('shows a confirmed early-stop log without offering to keep a full session', () => {
    const onSession = jest.fn<(_result: WritingSessionResult) => void>();
    const renderOffer = jest.fn(() => null);
    const screen = render(
      <WritingSessionSurface onSession={onSession} renderOffer={renderOffer} />,
    );
    fireEvent.press(screen.getByTestId('writing-timer-start'));
    jest.setSystemTime(T0 + 5 * MS_PER_MINUTE);
    fireEvent.press(screen.getByTestId('writing-timer-stop'));
    expect(screen.queryByTestId('writing-session-banner')).toBeNull();
    const result = onSession.mock.calls[0]![0];
    screen.rerender(
      <WritingSessionSurface
        onSession={onSession}
        renderOffer={renderOffer}
        loggedSession={{ result, message: 'Logged 5 minutes to Journaling' }}
      />,
    );
    expect(screen.getByText('You wrote for 5 minutes.')).toBeTruthy();
    expect(screen.getByText('Logged 5 minutes to Journaling')).toBeTruthy();
    expect(renderOffer).not.toHaveBeenCalled();
  });

  it('does not reopen a dismissed full-session note when its log confirms later', () => {
    const onSession = jest.fn<(_result: WritingSessionResult) => void>();
    const screen = render(<WritingSessionSurface onSession={onSession} />);
    fireEvent.press(screen.getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);
    const result = onSession.mock.calls[0]![0];
    fireEvent.press(screen.getByTestId('writing-session-banner-dismiss'));
    screen.rerender(
      <WritingSessionSurface
        onSession={onSession}
        loggedSession={{ result, message: 'Logged 20 minutes to Journaling' }}
      />,
    );
    expect(screen.queryByTestId('writing-session-banner')).toBeNull();
  });

  it('replaces an earlier note rather than stacking a second one', () => {
    const { getAllByTestId, getByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    const secondStart = T0 + 25 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-compact'));
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(secondStart + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    expect(getAllByTestId('writing-session-banner')).toHaveLength(1);
  });

  /**
   * A standing note is replaced only by a newer note, never merely erased: a
   * session the writer stopped early has nothing of its own to say, so what it
   * has to say cannot displace what the last finished session said.
   */
  it("leaves a finished session's note standing when the next session is stopped early", () => {
    const { getAllByTestId, getByTestId, getByText, queryByTestId } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    const secondStart = T0 + 25 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-compact'));
    fireEvent.press(getByTestId('writing-timer-start'));
    jest.setSystemTime(secondStart + 3 * MS_PER_MINUTE);
    fireEvent.press(getByTestId('writing-timer-stop'));

    expect(queryByTestId('writing-session-banner')).not.toBeNull();
    expect(getByText('You wrote for 20 minutes.')).toBeTruthy();
    expect(getAllByTestId('writing-session-banner')).toHaveLength(1);
  });

  it("swaps in the newer session's own note when the next session runs its length", () => {
    const { getByTestId, getByText, queryByText } = renderSurface();

    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(T0 + DEFAULT_WRITING_MINUTES * MS_PER_MINUTE);

    const secondStart = T0 + 25 * MS_PER_MINUTE;
    jest.setSystemTime(secondStart);
    fireEvent.press(getByTestId('writing-timer-compact'));
    fireEvent.press(getByTestId(`writing-timer-preset-${SHORT_PRESET_MINUTES}`));
    fireEvent.press(getByTestId('writing-timer-start'));
    tickTo(secondStart + SHORT_PRESET_MINUTES * MS_PER_MINUTE);

    expect(getByText('You wrote for 10 minutes.')).toBeTruthy();
    expect(queryByText('You wrote for 20 minutes.')).toBeNull();
  });
});
