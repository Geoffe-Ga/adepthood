/**
 * The explainer in front of "Promote a quote" (#2864).
 *
 * The first press, for an account that has not asked otherwise, opens
 * ``PromoteExplainerDialog`` instead of the selection field; its "Choose the
 * passage" arm then starts selection. Once the reader ticks "Don’t show this
 * again" — whichever arm they take after — the press goes straight to
 * selecting, on this device and any other this account signs in on.
 *
 * Only the dismissal and the dialog's own visibility live here. There is no
 * payer or wallet to consult: promoting is free, so unlike the resonance gate
 * this one never holds a press for anything but the stored flag.
 *
 * A press that arrives before that flag has been read waits for it rather than
 * taking a default, for the reason ``useStoredDismissal`` gives: defaulting to
 * "dismissed" would skip the note for a new reader, and defaulting to "not
 * dismissed" would flash it at someone who already turned it off. The read is
 * warmed at mount, so in practice it has settled before the button is reachable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useStoredDismissal } from './useStoredDismissal';

import {
  loadPromoteExplainerDismissed,
  savePromoteExplainerDismissed,
} from '@/storage/promoteExplainerStorage';

export interface PromoteExplainerGate {
  /** What "Promote a quote" presses: explain first, or start selecting. */
  onPress: () => void;
  /** Whether the explainer is on screen. */
  visible: boolean;
  /** The state of the "don’t show this again" box for this showing. */
  dontShowAgain: boolean;
  onToggleDontShowAgain: () => void;
  /** "Choose the passage": close the note and start selecting. */
  onContinue: () => void;
  /** "Not now", the scrim, or the hardware back: close the note, select nothing. */
  onCancel: () => void;
}

/** Whether the host is still mounted, so a late flag read cannot act on a gone screen. */
function useMountedRef(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return mounted;
}

/** Gate ``startSelecting`` behind the one-time promote explainer. */
export function usePromoteExplainer(startSelecting: () => void): PromoteExplainerGate {
  const flag = useStoredDismissal(loadPromoteExplainerDismissed, savePromoteExplainerDismissed);
  const mounted = useMountedRef();
  const [visible, setVisible] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // No tick reset on reopening: a note closed with the box ticked is never
  // shown again, so a reopened note can only have been closed unticked.
  const show = useCallback(() => setVisible(true), []);

  const onPress = useCallback(() => {
    const route = (dismissed: boolean): void => (dismissed ? startSelecting() : show());
    const known = flag.known();
    if (known !== null) {
      route(known);
      return;
    }
    void flag.read().then((dismissed) => {
      if (mounted.current) route(dismissed);
    });
  }, [flag, mounted, show, startSelecting]);

  const onToggleDontShowAgain = useCallback(() => setDontShowAgain((prev) => !prev), []);

  const onCancel = useCallback((): void => {
    setVisible(false);
    if (dontShowAgain) flag.markDismissed();
  }, [dontShowAgain, flag]);

  const onContinue = useCallback((): void => {
    onCancel();
    startSelecting();
  }, [onCancel, startSelecting]);

  // Memoised: the entry screen re-renders on every keystroke.
  return useMemo(
    () => ({ onPress, visible, dontShowAgain, onToggleDontShowAgain, onContinue, onCancel }),
    [onPress, visible, dontShowAgain, onToggleDontShowAgain, onContinue, onCancel],
  );
}
