/**
 * Re-read data every way a user can come *back* to a screen they never closed.
 *
 * There are two returns, and #2764 only covered one. A screen can be navigated
 * away from and back to, which React Navigation reports as focus; and the whole
 * app can be backgrounded and foregrounded, which it does not report at all —
 * the screen never lost focus, so nothing fires. A user who left the app on the
 * Habits tab overnight got the day boundary's re-render but no fresh read:
 * yesterday's streak, and any check-in accepted from the journal or another
 * device meanwhile, stayed on screen until they happened to switch tabs (#2847).
 *
 * Composed here rather than at each call site so both habit surfaces get the
 * same pair, and so the one rule that arbitrates between them has one home.
 */
import { NavigationContext } from '@react-navigation/native';
import { useCallback, useContext, useRef } from 'react';

import { useRefetchOnFocus } from './useRefetchOnFocus';

import { useRefetchOnDayBoundary } from '@/utils/dayRollover';

/**
 * Run `refetch` when the screen is returned to, and when the app is.
 *
 * The two triggers can name the same moment — foregrounding the app onto a tab
 * the user had navigated away from would fire the boundary now and the focus a
 * beat later — so the boundary defers to the focus path for a screen that is
 * not currently on screen. That is not merely deduplication: a blurred screen
 * has nothing to show anyone this instant, and it gets its fresh read at the
 * moment the user actually looks at it. Absent a navigator there are no focus
 * events to defer to, so the boundary always fires; that is the shape the ~18
 * suites exercising these hooks bare depend on, and production always has one.
 *
 * @param refetch - What to re-read. Need not be memoised: the most recently
 *   rendered one is the one that runs, so a caller can close over live values
 *   such as the auth-hydrated timezone without re-subscribing.
 */
export const useRefetchOnReturn = (refetch: () => void): void => {
  const navigation = useContext(NavigationContext);
  const latest = useRef(refetch);
  latest.current = refetch;

  useRefetchOnFocus(
    useCallback(() => {
      latest.current();
    }, []),
  );

  useRefetchOnDayBoundary(
    useCallback(() => {
      if (navigation !== undefined && !navigation.isFocused()) return;
      latest.current();
    }, [navigation]),
  );
};
