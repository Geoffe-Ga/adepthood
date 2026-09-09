/**
 * Re-read data each time the enclosing screen is *returned to*.
 *
 * The tab navigator keeps a screen mounted once it has been visited, so a
 * mount-only `useEffect` fetches exactly once for the lifetime of the app
 * session: the Habits tab and the journal shelf's habit tile both showed
 * whatever the store held when they were first opened, including across a
 * check-in made somewhere else and across a whole day boundary (#2764).
 *
 * Two deliberate choices:
 *
 * 1. **The context, not `useFocusEffect`.** `useFocusEffect` reaches the
 *    navigation object through `useNavigation`, which throws outside a
 *    navigator. The hooks that need this — `useBootstrapHabits`,
 *    `useHabitsSummary` — are data hooks, exercised bare by ~18 suites that
 *    have no business standing up a `NavigationContainer` to assert what the
 *    store did. Reading {@link NavigationContext} directly makes "no
 *    navigator" a legible state rather than a crash: with no navigator there
 *    are no focus events, so there is nothing to miss. Production always has
 *    one.
 * 2. **The return, not the arrival.** The navigator emits a `focus` event for
 *    the initially focused screen too, and the caller has already fetched on
 *    mount, so firing there would double every cold-start request. Tracking
 *    focus/blur transitions — the same bookkeeping `useFocusEffect` does
 *    internally — skips that one event without ever swallowing a real return,
 *    including for a tab that mounts lazily on the focus that created it.
 */
import { NavigationContext } from '@react-navigation/native';
import { useContext, useEffect, useRef } from 'react';

/**
 * Run `refetch` whenever the screen regains focus after having lost it.
 *
 * @param refetch - What to re-read. Need not be memoised: the most recently
 *   rendered one is always the one that runs, so a caller can close over live
 *   values such as the auth-hydrated timezone without re-subscribing.
 */
export const useRefetchOnFocus = (refetch: () => void): void => {
  const navigation = useContext(NavigationContext);
  const latest = useRef(refetch);
  latest.current = refetch;

  useEffect(() => {
    if (navigation === undefined) return undefined;

    let focused = navigation.isFocused();
    const unsubscribeFocus = navigation.addListener('focus', () => {
      // Already focused: this is the arrival the screen mounted for, which the
      // caller's own mount effect has covered.
      if (focused) return;
      focused = true;
      latest.current();
    });
    const unsubscribeBlur = navigation.addListener('blur', () => {
      focused = false;
    });

    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);
};
