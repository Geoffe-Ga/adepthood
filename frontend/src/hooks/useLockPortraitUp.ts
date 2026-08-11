/**
 * Holds the UI at portrait-up for the lifetime of the app.
 *
 * `app.json`'s static `"orientation": "portrait"` is necessary but not
 * sufficient, and it fails in three separate ways:
 *
 * 1. **iPad.** With `supportsTablet` and no `ios.requireFullScreen`, iOS treats
 *    the app as multitasking-capable and ignores the static lock entirely.
 * 2. **Contexts that never read the static config**, most obviously Expo Go.
 * 3. **Upside-down.** Plain `portrait` still permits portrait-upside-down on
 *    some hardware, and the request was specifically that the top of the device
 *    held vertically always be the top of the UI — hence `PORTRAIT_UP`.
 *
 * So the static value stays (it is what the OS applies before any JS runs, and
 * removing it would let the launch screen rotate) and this reasserts it at
 * runtime.
 *
 * Deliberately fail-soft: an orientation preference must never be the reason
 * the app does not start.
 */
import * as ScreenOrientation from 'expo-screen-orientation';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Lock the app to portrait-up once, on mount.
 *
 * A no-op on web: the browser Screen Orientation API rejects unless the
 * document is fullscreen, and this app ships to production on the web, so
 * calling it there buys nothing and costs an error on every load.
 *
 * Failures elsewhere are swallowed rather than surfaced. A simulator, an
 * unusual OEM build, or a future SDK change can all reject; none of them is a
 * reason to take the app down, and there is nothing a user could do about it.
 */
export function useLockPortraitUp(): void {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(
      () => undefined,
    );
    // Empty deps: the lock is a one-time startup assertion, not something that
    // tracks state. It is never released -- there is no context in this app
    // where landscape is wanted, so unlocking on unmount would only reintroduce
    // rotation during teardown.
  }, []);
}
