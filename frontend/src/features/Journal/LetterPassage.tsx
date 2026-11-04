/**
 * ``LetterPassage`` -- a Resonance Letter, and a way to lift a sentence out of
 * it (#3660).
 *
 * The letter reads as it always has. Beneath it, a quiet "Promote a quote"
 * opens the same gesture a journal page uses: the letter's text gives way to
 * ``QuoteSelectionSurface`` over the very same words, the floating Promote pill
 * comes to whatever passage the reader chooses, and the letter returns with
 * the shared notice under it. Whatever card the letter sits in -- the essay
 * modal over a page, or the Voice drafts shelf's letter -- stays open
 * throughout, so the first promote's one-time explainer is set in the card in
 * place of the letter rather than over it as a second dialog.
 *
 * The host renders this only for a real letter: never for the priced offer, a
 * letter still being written, an error, or the care surface a vault can send
 * instead. Only offsets go up (``promotions.createForLetter``); the server
 * slices the words from the letter it holds. Nothing is read when the letter
 * opens: the shelf promises a letter opens with no request at all, so the
 * passages already promoted from it are not drawn.
 */
import React, { useCallback, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, type StyleProp, type TextStyle } from 'react-native';

import { PromoteExplainerPanel } from './PromoteExplainerDialog';
import PromotionFeedback from './PromotionFeedback';
import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import { usePromoteExplainer } from './usePromoteExplainer';
import { usePromotions } from './usePromotions';

import { accent, spacing, touchTarget, editorialType } from '@/design/tokens';

/** The link under the letter, and what a screen reader calls it. */
export const LETTER_PROMOTE_LABEL = 'Promote a quote';
export const LETTER_PROMOTE_A11Y = 'Promote a quote from this letter';
const PROMOTE_LABEL = 'Promote';
const PROMOTE_A11Y = 'Promote this passage';

/** Prefix of the selection surface's testIDs inside a letter. */
const LETTER_SELECT_TEST_ID = 'letter-quote-select';

export interface LetterPassageProps {
  /** The margin note the letter belongs to: the id its promote route is keyed by. */
  marginaliaId: number;
  /** The letter itself: a real, non-empty essay. */
  essay: string;
  /** The letter text's style, as its card sets it. */
  textStyle?: StyleProp<TextStyle>;
  /** The letter text's testID, as its card has always named it. */
  textTestID: string;
  /** Shown under the letter while it is being read (its source line). */
  children?: ReactNode;
}

/** The letter's promote gesture: whether it is selecting, and what each control does. */
function useLetterPromotion(marginaliaId: number) {
  const promotion = usePromotions({ target: { kind: 'letter', marginaliaId }, hydrate: false });
  const [selecting, setSelecting] = useState(false);
  const spanRef = useRef<CodePointSpan>({ start: 0, end: 0 });
  const startSelecting = useCallback(() => {
    spanRef.current = { start: 0, end: 0 };
    setSelecting(true);
  }, []);
  const explainer = usePromoteExplainer(startSelecting);
  const onSelectionChange = useCallback((span: CodePointSpan) => {
    spanRef.current = span;
  }, []);
  const cancel = useCallback(() => setSelecting(false), []);
  const { promote } = promotion;
  // Back to the letter first, as a journal page does: the notice -- or the
  // failure and its retry -- is read beneath the letter, not over the field.
  // The surface lights its pill only for a non-empty passage.
  const confirm = useCallback(async (): Promise<void> => {
    const { start, end } = spanRef.current;
    setSelecting(false);
    await promote(start, end);
  }, [promote]);
  return { promotion, selecting, explainer, onSelectionChange, cancel, confirm };
}

function LetterPassage({
  marginaliaId,
  essay,
  textStyle,
  textTestID,
  children,
}: LetterPassageProps): React.JSX.Element {
  const { promotion, selecting, explainer, onSelectionChange, cancel, confirm } =
    useLetterPromotion(marginaliaId);

  if (explainer.visible) {
    return (
      <PromoteExplainerPanel
        sourceKind="letter"
        dontShowAgain={explainer.dontShowAgain}
        onToggleDontShowAgain={explainer.onToggleDontShowAgain}
        onContinue={explainer.onContinue}
        onCancel={explainer.onCancel}
      />
    );
  }
  if (selecting) {
    return (
      <QuoteSelectionSurface
        body={essay}
        testID={LETTER_SELECT_TEST_ID}
        confirmLabel={PROMOTE_LABEL}
        confirmAccessibilityLabel={PROMOTE_A11Y}
        onSelectionChange={onSelectionChange}
        onConfirm={confirm}
        onCancel={cancel}
      />
    );
  }
  return (
    <>
      <Text style={textStyle} testID={textTestID}>
        {essay}
      </Text>
      {children}
      <PromoteQuoteLink onPress={explainer.onPress} />
      <PromotionFeedback
        promoting={promotion.promoting}
        hint={promotion.hint}
        promoted={promotion.promoted}
        retryPromote={promotion.retryPromote}
      />
    </>
  );
}

/** The quiet link under the letter that opens the gesture. */
function PromoteQuoteLink({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.promoteLink}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={LETTER_PROMOTE_A11Y}
      testID="letter-promote-open"
    >
      <Text style={styles.promoteLinkText}>{LETTER_PROMOTE_LABEL}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  /** Quiet: the action face in the accent, a full touch target, no box of its own. */
  promoteLink: {
    alignSelf: 'flex-start',
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    marginTop: spacing(1),
  },
  promoteLinkText: {
    ...editorialType.action,
    color: accent.primary,
  },
});

export default LetterPassage;
