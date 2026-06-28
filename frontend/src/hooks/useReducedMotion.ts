/**
 * Track the OS "Reduce Motion" accessibility setting.
 *
 * Returns ``true`` when the user has asked the system to minimise non-essential
 * animation. The journal-depth motion (sheet settle-in, card press feedback)
 * checks this and renders the resting state with no transition when it is on,
 * so the polish never costs accessibility. Updates live if the setting changes
 * while the screen is mounted.
 */
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (active) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
