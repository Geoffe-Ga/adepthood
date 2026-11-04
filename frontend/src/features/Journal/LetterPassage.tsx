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
 * On the web the letter can also be promoted from right where it reads (#3661):
 * a reader who highlights a sentence of it meets the same floating pill over
 * the passage, and Promote lifts it with no selection field in between.
 * "Promote a quote" stays, the keyboard's and the screen reader's way in.
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

import type { AnchorSpan } from './anchorSpan';
import { PromoteExplainerPanel } from './PromoteExplainerDialog';
import PromotionFeedback from './PromotionFeedback';
import QuoteSelectionSurface, { type CodePointSpan } from './QuoteSelectionSurface';
import { letterSourceSpan } from './renderedSelection';
import RenderedSelectionPill, { STEP_ASIDE } from './RenderedSelectionPill';
import { usePromoteGate, type PromoteGate } from './usePromoteGate';
import { usePromotions } from './usePromotions';
import { clearRenderedSelection, useHighlightedPassage } from './useRenderedSelection';

import { decorativeHidden } from '@/components/a11yHidden';
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
  const { promote } = promotion;
  // A passage highlighted on the rendered letter goes up as it is (#3661); the
  // selection is let go first, as the field is, and the notice reads beneath.
  const promoteHighlighted = useCallback(
    (span: AnchorSpan): void => {
      clearRenderedSelection();
      void promote(span.start, span.end);
    },
    [promote],
  );
  const gate = usePromoteGate(startSelecting, promoteHighlighted);
  const onSelectionChange = useCallback((span: CodePointSpan) => {
    spanRef.current = span;
  }, []);
  const cancel = useCallback(() => setSelecting(false), []);
  // Back to the letter first, as a journal page does: the notice -- or the
  // failure and its retry -- is read beneath the letter, not over the field.
  // The surface lights its pill only for a non-empty passage.
  const confirm = useCallback(async (): Promise<void> => {
    const { start, end } = spanRef.current;
    setSelecting(false);
    await promote(start, end);
  }, [promote]);
  return { promotion, selecting, gate, onSelectionChange, cancel, confirm };
}

/** The letter as it reads, its two doors to Promote, and what a promote says beneath it. */
function LetterReading({
  essay,
  textStyle,
  textTestID,
  children,
  promotion,
  gate,
}: Omit<LetterPassageProps, 'marginaliaId'> & {
  promotion: ReturnType<typeof usePromotions>;
  gate: PromoteGate;
}): React.JSX.Element {
  const textRef = useRef<Text>(null);
  // On the web, a passage highlighted right in the letter (#3661).
  const passage = useHighlightedPassage(textRef, essay, letterSourceSpan);
  return (
    <>
      <Text ref={textRef} style={textStyle} testID={textTestID}>
        {essay}
      </Text>
      {children}
      <PromoteQuoteLink onPress={gate.openSelection} stepAside={passage !== null} />
      <PromotionFeedback
        promoting={promotion.promoting}
        hint={promotion.hint}
        promoted={promotion.promoted}
        retryPromote={promotion.retryPromote}
      />
      <RenderedSelectionPill
        passage={passage}
        onPromote={gate.promotePassage}
        label={PROMOTE_LABEL}
        accessibilityLabel={PROMOTE_A11Y}
        busy={promotion.promoting}
      />
    </>
  );
}

function LetterPassage({ marginaliaId, ...letter }: LetterPassageProps): React.JSX.Element {
  const { promotion, selecting, gate, onSelectionChange, cancel, confirm } =
    useLetterPromotion(marginaliaId);
  const { explainer } = gate;

  if (explainer.visible) {
    return (
      <PromoteExplainerPanel
        sourceKind="letter"
        passageChosen={gate.passageChosen}
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
        body={letter.essay}
        testID={LETTER_SELECT_TEST_ID}
        confirmLabel={PROMOTE_LABEL}
        confirmAccessibilityLabel={PROMOTE_A11Y}
        onSelectionChange={onSelectionChange}
        onConfirm={confirm}
        onCancel={cancel}
      />
    );
  }
  return <LetterReading {...letter} promotion={promotion} gate={gate} />;
}

/**
 * The quiet link under the letter that opens the gesture. While a passage
 * highlighted in the letter is chosen (web, #3661) the floating pill rests on
 * this row in its stead, so the link steps aside: in place, unseen and inert.
 */
function PromoteQuoteLink({
  onPress,
  stepAside,
}: {
  onPress: () => void;
  stepAside: boolean;
}): React.JSX.Element {
  return (
    <TouchableOpacity
      style={[styles.promoteLink, stepAside && STEP_ASIDE]}
      onPress={onPress}
      disabled={stepAside}
      {...(stepAside ? decorativeHidden() : null)}
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
