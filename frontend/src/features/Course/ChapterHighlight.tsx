/**
 * ``ChapterHighlight`` -- on the web, promote a passage highlighted right on a
 * rendered Course chapter (#3661).
 *
 * The chapter is drawn by ``react-native-markdown-display``, which keeps no
 * source offsets, so the highlighted words are found in a projection of the
 * Markdown (``chapterProjection``). Where that placing is exact the floating
 * pill offers what the selection field's pill offers -- Promote, beside Write
 * a note -- and Promote goes up over the chapter's own route, shifted past the
 * stripped title heading as the field's promote is. Where it is only a guess
 * (a table, a list's drawn numbers, markup the projection does not follow) the
 * pill says so honestly: Choose this passage… opens the #3660 selection field
 * with the guess already chosen, for the reader to confirm or adjust.
 *
 * The first Promote explains itself with the same one-time note as the field's
 * (worded for a passage already chosen), and its notice floats where the pill
 * was, as a chapter's does.
 */
import React, { useCallback, useMemo, useRef, type RefObject } from 'react';

import type { AnchorSpan } from '../Journal/anchorSpan';
import type { FloatingSecondaryAction } from '../Journal/FloatingPromoteButton';
import { RESONANCE_BUTTON_CLEARANCE } from '../Journal/JournalEntry.styles';
import PromoteExplainerDialog from '../Journal/PromoteExplainerDialog';
import RenderedSelectionPill from '../Journal/RenderedSelectionPill';
import { usePromoteExplainer, type PromoteExplainerGate } from '../Journal/usePromoteExplainer';
import { usePromotions } from '../Journal/usePromotions';
import { clearRenderedSelection, useRenderedSelection } from '../Journal/useRenderedSelection';

import { strippedPrefixLength } from './chapterHighlight';
import { chapterPassage, projectChapter, type ChapterPassage } from './chapterProjection';
import type { ChapterPromotionFeedback } from './useChapterPromotion';

import { SPACING, touchTarget } from '@/design/tokens';

const PROMOTE_LABEL = 'Promote';
const PROMOTE_A11Y = 'Promote this passage';
const WRITE_NOTE_LABEL = 'Write a note';
const WRITE_NOTE_A11Y = 'Write a note on this passage';
/** The honest pill, when the passage could only be guessed at: the field confirms it. */
export const CHOOSE_PASSAGE_LABEL = 'Choose this passage…';
const CHOOSE_PASSAGE_A11Y = 'Choose this passage in the selection field';

/**
 * Nothing follows a chapter's text inside its sheet, so the band under it is
 * the whole pill and its breath above its lift: at the chapter's end the
 * resting pill clears the last line.
 */
const CHAPTER_PILL_RESERVE = RESONANCE_BUTTON_CLEARANCE + touchTarget.minimum + SPACING.sm;

/** The passage the reader has highlighted in a rendered chapter, or null. */
export function useChapterHighlight(
  markdownRef: RefObject<unknown>,
  markdown: string,
): ChapterPassage | null {
  const projection = useMemo(() => projectChapter(markdown), [markdown]);
  const toPassage = useCallback(
    (selection: Parameters<typeof chapterPassage>[1]) => chapterPassage(projection, selection),
    [projection],
  );
  return useRenderedSelection(markdownRef, toPassage);
}

/** A chapter a passage can be promoted from: its id, and the body exactly as served. */
export interface HighlightPromoteSource {
  contentId: number;
  served: string;
  title: string;
}

/** Promote a highlighted chapter passage behind the one-time note; what the notice reads. */
interface HighlightPromotion {
  promote: (_span: AnchorSpan) => void;
  busy: boolean;
  feedback: ChapterPromotionFeedback;
  explainer: PromoteExplainerGate;
}

/**
 * The reading view's promote: ``usePromotions`` over the chapter, the span
 * shifted past the stripped title heading, and the note read at press time
 * against the passage chosen then (the selection itself is gone by the time
 * its go-ahead lands).
 */
export function useHighlightPromotion(source: HighlightPromoteSource | null): HighlightPromotion {
  const { promote, promoting, hint, promoted, retryPromote } = usePromotions({
    target: { kind: 'course', contentId: source?.contentId ?? 0 },
    hydrate: false,
  });
  const shift = useMemo(
    () => (source === null ? 0 : strippedPrefixLength(source.served, source.title)),
    [source],
  );
  const chosen = useRef<AnchorSpan | null>(null);
  const proceed = useCallback((): void => {
    const span = chosen.current;
    chosen.current = null;
    if (span === null) return;
    clearRenderedSelection();
    void promote(span.start + shift, span.end + shift);
  }, [promote, shift]);
  const explainer = usePromoteExplainer(proceed);
  const { onPress } = explainer;
  const promoteSpan = useCallback(
    (span: AnchorSpan): void => {
      chosen.current = span;
      onPress();
    },
    [onPress],
  );
  return {
    promote: promoteSpan,
    busy: promoting,
    feedback: { promoting, hint, promoted, retryPromote },
    explainer,
  };
}

export interface ChapterHighlightPillProps {
  passage: ChapterPassage | null;
  /** Null for a reading with no chapter to promote from (an introduction, a resource). */
  promotion: HighlightPromotion | null;
  /** Write a note on the passage; omitted where the reader offers no notes. */
  onWriteNote?: (_span: AnchorSpan) => void;
  /** Open the selection field with ``seed`` chosen, when one is worth offering. */
  onChoose: (_seed?: AnchorSpan) => void;
}

/** What the pill says and does. */
interface PillOffer {
  label: string;
  accessibilityLabel: string;
  onPromote: (_span: AnchorSpan) => void;
  secondaryAction?: FloatingSecondaryAction;
}

/** The honest offer for a guessed passage: confirm it in the selection field. */
function chooseOffer(passage: ChapterPassage, onChoose: (_seed?: AnchorSpan) => void): PillOffer {
  const seed = passage.end > passage.start ? { start: passage.start, end: passage.end } : undefined;
  return {
    label: CHOOSE_PASSAGE_LABEL,
    accessibilityLabel: CHOOSE_PASSAGE_A11Y,
    onPromote: () => {
      clearRenderedSelection();
      onChoose(seed);
    },
  };
}

/** Write a note on an exactly placed passage, beside Promote or on its own. */
function writeNoteAction(passage: ChapterPassage, onWriteNote: (_span: AnchorSpan) => void) {
  return {
    label: WRITE_NOTE_LABEL,
    accessibilityLabel: WRITE_NOTE_A11Y,
    onPress: () => onWriteNote(passage),
  };
}

/** What the pill offers for ``passage``, from what this reading can do with one; null for nothing. */
function pillFor({
  passage,
  promotion,
  onWriteNote,
  onChoose,
}: ChapterHighlightPillProps): PillOffer | null {
  if (passage === null || (promotion === null && onWriteNote === undefined)) return null;
  if (!passage.exact) return chooseOffer(passage, onChoose);
  const note = onWriteNote === undefined ? undefined : writeNoteAction(passage, onWriteNote);
  if (promotion === null) {
    return note === undefined ? null : { ...note, onPromote: note.onPress };
  }
  return {
    label: PROMOTE_LABEL,
    accessibilityLabel: PROMOTE_A11Y,
    onPromote: promotion.promote,
    secondaryAction: note,
  };
}

/** The pill over a highlighted chapter passage, last in the reading sheet. */
export function ChapterHighlightPill(props: ChapterHighlightPillProps): React.JSX.Element {
  const pill = pillFor(props);
  return (
    <RenderedSelectionPill
      passage={pill === null ? null : props.passage}
      onPromote={pill?.onPromote ?? clearRenderedSelection}
      label={pill?.label}
      accessibilityLabel={pill?.accessibilityLabel}
      secondaryAction={pill?.secondaryAction}
      busy={props.promotion?.busy ?? false}
      reserve={CHAPTER_PILL_RESERVE}
    />
  );
}

/** The highlight promote's one-time note: the chapter's own, worded for a chosen passage. */
export function HighlightPromoteExplainer({
  explainer,
}: {
  explainer: PromoteExplainerGate;
}): React.JSX.Element {
  return (
    <PromoteExplainerDialog
      visible={explainer.visible}
      sourceKind="course"
      passageChosen
      dontShowAgain={explainer.dontShowAgain}
      onToggleDontShowAgain={explainer.onToggleDontShowAgain}
      onContinue={explainer.onContinue}
      onCancel={explainer.onCancel}
    />
  );
}
