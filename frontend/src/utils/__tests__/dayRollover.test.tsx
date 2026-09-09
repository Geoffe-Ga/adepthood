/**
 * The one owner of the day boundary.
 *
 * These tests pin the two properties the habit surfaces depend on and that no
 * pure day-math test can see: that a subscriber's day key changes *without a
 * remount* when the boundary passes, and that however many surfaces subscribe
 * there is still exactly one pending timer — a per-component timer, or a short
 * poll approximating a rollover, would pass a "does it eventually flip?" test
 * and fail these.
 */
import { jest, describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { render, renderHook, act } from '@testing-library/react-native';
import React from 'react';
import { AppState, Text } from 'react-native';
import type { AppStateStatus, NativeEventSubscription } from 'react-native';

import { useDayKey } from '../dayRollover';

/** Handlers the module registered with `AppState`, newest last. */
let foregroundHandlers: Array<(_status: AppStateStatus) => void> = [];
let removedSubscriptions = 0;

/** 2026-02-10T23:50:00Z — ten minutes before UTC's day turns over. */
const BEFORE_UTC_MIDNIGHT = new Date('2026-02-10T23:50:00.000Z').getTime();
const TEN_MINUTES_MS = 600_000;
const ONE_DAY_MS = 86_400_000;

const foreground = (): void => {
  for (const handler of foregroundHandlers) {
    handler('active');
  }
};

const DayKeyProbe = ({ tz }: { tz: string }): React.JSX.Element => (
  <Text testID={`day-${tz}`}>{useDayKey(tz)}</Text>
);

/*
 * Nested inside a describe on purpose: `jest.setup.js` registers a root-level
 * `afterEach` that drains pending fake timers, and root-level hooks run before
 * this file's would. A block-scoped teardown runs first, so the armed rollover
 * is dropped before that drain can fire it into a tree being torn down.
 */
describe('useDayKey', () => {
  beforeEach(() => {
    foregroundHandlers = [];
    removedSubscriptions = 0;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
      if (type === 'change') {
        foregroundHandlers.push(handler as (_status: AppStateStatus) => void);
      }
      return {
        remove: () => {
          removedSubscriptions += 1;
        },
      } as NativeEventSubscription;
    });
    jest.useFakeTimers();
    jest.setSystemTime(BEFORE_UTC_MIDNIGHT);
  });

  afterEach(() => {
    // Drop the armed rollover before the shared teardown drains pending timers:
    // that drain runs outside `act`, and a boundary firing there would re-render
    // a tree the harness is already unmounting.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('crossing the boundary', () => {
    it('reports the current calendar day in the given zone', () => {
      const { result } = renderHook(() => useDayKey('UTC'));

      expect(result.current).toBe('2026-02-10');
    });

    it('flips to the next day when the boundary passes, without a remount', () => {
      const { result } = renderHook(() => useDayKey('UTC'));
      expect(result.current).toBe('2026-02-10');

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });

      expect(result.current).toBe('2026-02-11');
    });

    it('does not flip early: nine of the ten minutes leave the day alone', () => {
      const { result } = renderHook(() => useDayKey('UTC'));

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS - 60_000);
      });

      expect(result.current).toBe('2026-02-10');
    });

    it('re-arms after firing, so a second boundary flips it again', () => {
      const { result } = renderHook(() => useDayKey('UTC'));

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });
      act(() => {
        jest.advanceTimersByTime(ONE_DAY_MS);
      });

      expect(result.current).toBe('2026-02-12');
    });
  });

  describe('the user timezone, not the device one', () => {
    it('holds a zone east of UTC on the day it is already living in', () => {
      // 23:50Z on the 10th is 08:50 on the 11th in Tokyo (UTC+9): its day turned
      // over nine hours ago, and UTC's imminent midnight is not its boundary.
      const { result } = renderHook(() => useDayKey('Asia/Tokyo'));
      expect(result.current).toBe('2026-02-11');

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });

      expect(result.current).toBe('2026-02-11');
    });

    it('flips a zone east of UTC at its own midnight, not at UTC midnight', () => {
      // Tokyo's next boundary is 2026-02-12 00:00 JST = 2026-02-11T15:00Z, which
      // is 15h10m after the fixture instant.
      const { result } = renderHook(() => useDayKey('Asia/Tokyo'));

      act(() => {
        jest.advanceTimersByTime(15 * 3_600_000 + TEN_MINUTES_MS);
      });

      expect(result.current).toBe('2026-02-12');
    });

    it('holds a zone west of UTC through UTC midnight and flips at its own', () => {
      // 23:50Z on the 10th is 15:50 on the 10th in Los Angeles (UTC-8); its next
      // boundary is 2026-02-11 00:00 PST = 2026-02-11T08:00Z, 8h10m away.
      const { result } = renderHook(() => useDayKey('America/Los_Angeles'));
      expect(result.current).toBe('2026-02-10');

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });
      expect(result.current).toBe('2026-02-10');

      act(() => {
        jest.advanceTimersByTime(8 * 3_600_000);
      });
      expect(result.current).toBe('2026-02-11');
    });
  });

  describe('one owner of the boundary', () => {
    it('arms exactly one timer however many surfaces subscribe', () => {
      render(
        <>
          <DayKeyProbe tz="UTC" />
          <DayKeyProbe tz="UTC" />
          <DayKeyProbe tz="UTC" />
        </>,
      );

      expect(jest.getTimerCount()).toBe(1);
    });

    it('flips every subscriber from the same fire', () => {
      const { getAllByTestId } = render(
        <>
          <DayKeyProbe tz="UTC" />
          <DayKeyProbe tz="UTC" />
        </>,
      );

      act(() => {
        jest.advanceTimersByTime(TEN_MINUTES_MS);
      });

      for (const node of getAllByTestId('day-UTC')) {
        expect(node).toHaveTextContent('2026-02-11');
      }
    });

    it('arms for the soonest boundary among the zones in play', () => {
      // Tokyo (15h10m away) and Los Angeles (8h10m away) together: a scheduler
      // that armed for whichever zone registered last would leave the other
      // stale for hours.
      const { getByTestId } = render(
        <>
          <DayKeyProbe tz="Asia/Tokyo" />
          <DayKeyProbe tz="America/Los_Angeles" />
        </>,
      );

      act(() => {
        jest.advanceTimersByTime(8 * 3_600_000 + TEN_MINUTES_MS);
      });

      expect(getByTestId('day-Asia/Tokyo')).toHaveTextContent('2026-02-11');
      expect(getByTestId('day-America/Los_Angeles')).toHaveTextContent('2026-02-11');

      // And the later zone is still served after the earlier one has fired:
      // 2026-02-11T15:00Z is Tokyo's midnight and 07:00 in Los Angeles.
      act(() => {
        jest.advanceTimersByTime(7 * 3_600_000);
      });

      expect(getByTestId('day-Asia/Tokyo')).toHaveTextContent('2026-02-12');
      expect(getByTestId('day-America/Los_Angeles')).toHaveTextContent('2026-02-11');
    });

    it('leaves no timer pending once the last subscriber unmounts', () => {
      const first = render(<DayKeyProbe tz="UTC" />);
      const second = render(<DayKeyProbe tz="UTC" />);

      first.unmount();
      expect(jest.getTimerCount()).toBe(1);

      second.unmount();
      expect(jest.getTimerCount()).toBe(0);
      expect(removedSubscriptions).toBe(1);
    });
  });

  describe('holding the process open', () => {
    it('does not keep a host runtime alive waiting for midnight', () => {
      // Real timers: the boundary is up to ~24h away, and under Node a
      // referenced timer of that length keeps the event loop — and so a Jest
      // worker — alive long after the tests that armed it have passed. The
      // subscription is what schedules it, so this is the module's own
      // problem, not the harness's.
      jest.useRealTimers();
      const armed: Array<ReturnType<typeof setTimeout>> = [];
      const realSetTimeout = globalThis.setTimeout;
      jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
        handler: () => void,
        delay?: number,
      ) => {
        const handle = realSetTimeout(handler, delay);
        armed.push(handle);
        return handle;
      }) as typeof globalThis.setTimeout);

      const { unmount } = renderHook(() => useDayKey('UTC'));
      const referenced = armed.filter(
        (handle) => (handle as unknown as { hasRef?: () => boolean }).hasRef?.() === true,
      );
      unmount();

      expect(armed.length).toBeGreaterThan(0);
      expect(referenced).toEqual([]);
    });
  });

  describe('returning from the background', () => {
    it('re-reads the day when the app foregrounds past a boundary its timer slept through', () => {
      const { result } = renderHook(() => useDayKey('UTC'));
      expect(result.current).toBe('2026-02-10');

      // A suspended app's timers do not run: move the wall clock past midnight
      // without letting the pending timeout fire, exactly as an OS that froze
      // the JS thread would.
      jest.setSystemTime(BEFORE_UTC_MIDNIGHT + TEN_MINUTES_MS + 1_000);
      expect(result.current).toBe('2026-02-10');

      act(() => {
        foreground();
      });

      expect(result.current).toBe('2026-02-11');
    });

    it('subscribes to the foreground signal exactly once for many subscribers', () => {
      render(
        <>
          <DayKeyProbe tz="UTC" />
          <DayKeyProbe tz="UTC" />
          <DayKeyProbe tz="UTC" />
        </>,
      );

      expect(foregroundHandlers).toHaveLength(1);
    });

    it('re-arms on foreground so the next boundary still fires on time', () => {
      const { result } = renderHook(() => useDayKey('UTC'));

      jest.setSystemTime(BEFORE_UTC_MIDNIGHT + TEN_MINUTES_MS + 1_000);
      act(() => {
        foreground();
      });
      expect(result.current).toBe('2026-02-11');

      act(() => {
        jest.advanceTimersByTime(ONE_DAY_MS);
      });

      expect(result.current).toBe('2026-02-12');
    });
  });
});
