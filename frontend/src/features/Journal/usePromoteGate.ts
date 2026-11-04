/**
 * ``usePromoteGate`` -- one promote note in front of both ways a reader reaches
 * Promote on a reading surface (#3661).
 *
 * "Promote a quote" opens the selection field. On the web the floating pill
 * over a passage highlighted right on the rendered page promotes that passage
 * outright. The first press of either, for an account that has not asked
 * otherwise, shows the one-time explainer (``usePromoteExplainer``) -- worded
 * for a passage already chosen when the pill opened it -- and its go-ahead
 * then does what was pressed: open the field, or promote the passage.
 *
 * One gate, so one stored dismissal: a "Don’t show this again" ticked in front
 * of one door is honoured at the other in the same session, which two gates
 * each holding their own copy of the flag would not do.
 */
import { useCallback, useMemo, useRef, useState } from 'react';

import type { AnchorSpan } from './anchorSpan';
import { usePromoteExplainer, type PromoteExplainerGate } from './usePromoteExplainer';

export interface PromoteGate {
  /** The note's state, for the host's ``PromoteExplainerDialog`` or panel. */
  explainer: PromoteExplainerGate;
  /** The note stands in front of a passage already chosen (the pill), not of choosing one. */
  passageChosen: boolean;
  /** "Promote a quote": explain first (once), then open the selection field. */
  openSelection: () => void;
  /** The pill: explain first (once), then promote ``span``. */
  promotePassage: (_span: AnchorSpan) => void;
}

/** Gate ``startSelecting`` and ``promoteSpan`` behind the one-time promote note. */
export function usePromoteGate(
  startSelecting: () => void,
  promoteSpan: (_span: AnchorSpan) => void,
): PromoteGate {
  // Held in a ref and read at the go-ahead: the note's answer arrives renders
  // after the press, and must act on the passage chosen at the press.
  const chosen = useRef<AnchorSpan | null>(null);
  const [passageChosen, setPassageChosen] = useState(false);

  const proceed = useCallback((): void => {
    const span = chosen.current;
    chosen.current = null;
    if (span === null) startSelecting();
    else promoteSpan(span);
  }, [startSelecting, promoteSpan]);

  const explainer = usePromoteExplainer(proceed);
  const { onPress } = explainer;

  const openSelection = useCallback((): void => {
    chosen.current = null;
    setPassageChosen(false);
    onPress();
  }, [onPress]);

  const promotePassage = useCallback(
    (span: AnchorSpan): void => {
      chosen.current = span;
      setPassageChosen(true);
      onPress();
    },
    [onPress],
  );

  return useMemo(
    () => ({ explainer, passageChosen, openSelection, promotePassage }),
    [explainer, passageChosen, openSelection, promotePassage],
  );
}
