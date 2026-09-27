/**
 * Whether the enclosing navigator screen is the one in front.
 *
 * A stack keeps a covered screen mounted, so anything that listens globally
 * (Escape on ``document``, the hardware back button) must stand down while its
 * screen is covered, or it answers for a screen the reader cannot see (#2883).
 *
 * Reads {@link NavigationContext} directly rather than ``useIsFocused``, which
 * throws outside a navigator: with no navigator there is nothing to cover the
 * component, so it reads as focused (see ``useRefetchOnFocus`` for the same
 * choice).
 */
import { NavigationContext } from '@react-navigation/native';
import { useContext, useEffect, useState } from 'react';

export function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);

  useEffect(() => {
    if (navigation === undefined) return undefined;
    setFocused(navigation.isFocused());
    const unsubscribeFocus = navigation.addListener('focus', () => setFocused(true));
    const unsubscribeBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      unsubscribeFocus();
      unsubscribeBlur();
    };
  }, [navigation]);

  return focused;
}
