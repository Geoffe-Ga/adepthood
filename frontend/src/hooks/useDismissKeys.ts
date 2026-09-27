/**
 * Close a non-modal surface (an inline side pane) the way a modal one closes:
 * Escape on web, the hardware back button on native.
 *
 * A ``Modal`` gets both from ``onRequestClose``; an inline pane gets neither, so
 * without this Android back pops the whole route out from under an open pane.
 *
 * Web listens on ``keydown`` while react-native-web's own Modals close on
 * ``keyup``, so one Escape would otherwise take down both an open dialog and
 * the pane beneath it. While any ``aria-modal`` dialog is open, Escape is left to
 * that dialog alone.
 */
import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';

/** The one key that dismisses on web. */
const DISMISS_KEY = 'Escape';

/** Present in the DOM while any react-native-web Modal (which owns Escape) is open. */
const OPEN_MODAL_SELECTOR = '[aria-modal="true"]';

export function useDismissKeys(onDismiss: () => void, enabled: boolean): void {
  // Held in a ref so a new handler identity each render never re-subscribes.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!enabled) return undefined;
    if (Platform.OS === 'web') {
      // Captured, not re-resolved: a cleanup that reaches for the ``document``
      // global at teardown may find the DOM already gone.
      const doc = document;
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== DISMISS_KEY) return;
        if (doc.querySelector(OPEN_MODAL_SELECTOR) != null) return;
        onDismissRef.current();
      };
      doc.addEventListener('keydown', onKeyDown);
      return () => doc.removeEventListener('keydown', onKeyDown);
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismissRef.current();
      // Consumed: the pane closes and the route stays where it is.
      return true;
    });
    return () => subscription.remove();
  }, [enabled]);
}
