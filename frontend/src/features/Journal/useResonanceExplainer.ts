/**
 * The gate in front of a charged resonance pass.
 *
 * A press on "Get Resonance" used to reach ``resonance.generate`` directly, and
 * that call deducts one message from the account's BotMason allowance before it
 * dials the model. This hook puts the spend disclosure in between: the first
 * press (for an account that has not asked otherwise) opens
 * ``ResonanceExplainerDialog``, and only the dialog's Continue arm runs the
 * pass.
 *
 * It never calls the API itself. ``requestResonance`` comes in and goes out
 * unchanged, guarded — there is still exactly one charge path in the screen, and
 * ``useResonance``'s own in-flight latch still owns "one pass at a time".
 *
 * A press that arrives before the stored flag has been read *waits* for it
 * rather than taking a default. The two possible defaults are not symmetric:
 * showing the note to someone who already dismissed it costs them a tap, while
 * skipping it because the read had not landed yet spends their money without
 * telling them. Waiting has neither cost, and the read is started at mount, so
 * in practice it has already settled by the time the affordance is reachable —
 * which is why the settled case is answered in the same tick as the press
 * instead of a microtask later.
 *
 * This is also why the "null while loading, render nothing" shape that
 * ``MorningPagesTip`` uses is deliberately NOT copied here. That shape exists to
 * stop a passively-rendered band from flashing on every mount; this surface is
 * not rendered until a press asks for it, so it has no flash to prevent — and
 * borrowing the shape would mean a press during the read either did nothing or
 * silently fell through to the charge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  loadResonanceExplainerDismissed,
  saveResonanceExplainerDismissed,
} from '@/storage/resonanceExplainerStorage';

export interface ResonanceExplainerGate {
  /** What "Get Resonance" presses: disclose first, or run the pass. */
  onPress: () => Promise<void>;
  /** Whether the disclosure is on screen. */
  visible: boolean;
  /** The state of the "don’t show this again" box for this showing. */
  dontShowAgain: boolean;
  onToggleDontShowAgain: () => void;
  /** Take the charged arm: close, persist any tick, then run the pass. */
  onContinue: () => void;
  /** Leave without a pass; a ticked box is still honoured. */
  onCancel: () => void;
}

/** The stored dismissal, as the gate needs to consult it. */
interface DismissedFlag {
  /** The answer if it is already in hand, or ``null`` while the read is out. */
  known: () => boolean | null;
  /** The answer, waiting for the read if it has not landed yet. */
  read: () => Promise<boolean>;
  /** Record the reader's "don’t show this again", in memory and on disk. */
  markDismissed: () => void;
}

/**
 * The stored flag, read once per mount and remembered.
 *
 * Two refs rather than one, because they answer different questions: ``settled``
 * lets a press that already has the answer act on it in the same tick, and
 * ``pending`` lets a press that does not wait for the real answer rather than
 * take a default.
 */
function useDismissedFlag(): DismissedFlag {
  const settled = useRef<boolean | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);

  const read = useCallback((): Promise<boolean> => {
    pending.current ??= loadResonanceExplainerDismissed().then((stored) => {
      settled.current = stored;
      return stored;
    });
    return pending.current;
  }, []);

  // Warm the read at mount so a press is almost never the thing waiting on it.
  useEffect(() => {
    void read();
  }, [read]);

  const markDismissed = useCallback((): void => {
    // Memory first, disk after: a second press in the same session must not be
    // able to race the write and be shown the note it was just dismissed from.
    settled.current = true;
    pending.current = Promise.resolve(true);
    void saveResonanceExplainerDismissed(true);
  }, []);

  const known = useCallback((): boolean | null => settled.current, []);

  // Memoised: the entry screen re-renders on every keystroke, and an unstable
  // flag object would hand the resonance button a fresh onPress each time.
  return useMemo(() => ({ known, read, markDismissed }), [known, read, markDismissed]);
}

/**
 * Gate ``requestResonance`` behind the spend disclosure.
 *
 * @param requestResonance - the screen's one charged pass, called unchanged.
 */
export function useResonanceExplainer(
  requestResonance: () => Promise<void>,
): ResonanceExplainerGate {
  const [visible, setVisible] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const flag = useDismissedFlag();

  /** Act on the stored answer: run the pass, or disclose what it would cost. */
  const decide = useCallback(
    (isDismissed: boolean): void => {
      if (isDismissed) {
        void requestResonance();
        return;
      }
      setDontShowAgain(false);
      setVisible(true);
    },
    [requestResonance],
  );

  const onPress = useCallback(async (): Promise<void> => {
    // Deliberately synchronous once the answer is in hand: deferring a decision
    // that is already made would put the loading state a tick behind the thumb.
    const known = flag.known();
    if (known !== null) {
      decide(known);
      return;
    }
    decide(await flag.read());
  }, [decide, flag]);

  const onToggleDontShowAgain = useCallback(() => {
    setDontShowAgain((prev) => !prev);
  }, []);

  /**
   * Close the disclosure and honour a ticked box — on either arm, because "don’t
   * show this again" is an answer about the note, not an endorsement of the
   * charge. Backing out with the box ticked still runs nothing.
   */
  const close = useCallback((): void => {
    setVisible(false);
    if (!dontShowAgain) return;
    flag.markDismissed();
  }, [dontShowAgain, flag]);

  const onContinue = useCallback((): void => {
    close();
    void requestResonance();
  }, [close, requestResonance]);

  return { onPress, visible, dontShowAgain, onToggleDontShowAgain, onContinue, onCancel: close };
}
