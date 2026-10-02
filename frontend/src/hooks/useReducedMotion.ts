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

/**
 * The same setting, but ``null`` until the OS has answered — for a one-shot
 * motion (a scroll that latches) that must not start before it knows. A read
 * that fails resolves ``true``: when the writer's wish cannot be read, the
 * motion that cannot be taken back is made without animation.
 */
export function useReducedMotionSetting(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (active) setReduced(value);
      },
      () => {
        if (active) setReduced(true);
      },
    );
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
