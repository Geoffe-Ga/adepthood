/**
 * ``PromotionFeedback`` -- what a promote says once it is pressed: "Promoting…"
 * while the post is in flight, the failure and a same-anchors "Try again", or
 * the notice that names where the quote went (#2864).
 *
 * Shared by every surface that promotes a passage -- a journal page in read
 * mode, a Course chapter and a Resonance Letter (#3660) -- so a reader meets
 * the same words in the same order wherever they promote. It renders lines
 * only; the host decides where they sit (under the body, at the foot of a
 * letter card, or on the card a chapter floats where its pill was).
 *
 * An error outranks a lingering success notice, so a failed remove that lands
 * while an earlier "Promoted" is still up reads honestly.
 */
import React, { useEffect } from 'react';
import { Animated, Text } from 'react-native';

import styles from './JournalEntry.styles';
import { PROMOTED_NOTICE_COPY } from './promoteExplainerCopy';

import { Button } from '@/components/Button';
import { useEntrance } from '@/hooks/useEntrance';
import { announceOnIos } from '@/utils/announceOnIos';

/** Copy for the in-flight line (a real ellipsis). */
export const PROMOTING_COPY = 'Promoting…';

/** The promote lifecycle, as ``usePromotions`` reports it. */
export interface PromotionFeedbackProps {
  promoting: boolean;
  /** Warm copy for the latest failure; null when all is well. */
  hint: string | null;
  promoted: boolean;
  /** Re-post the last attempted span; null unless the latest promote failed. */
  retryPromote: (() => Promise<void>) | null;
  /** Say "Promoting…" while the post is in flight; off where a busy pill already says so. */
  showInflight?: boolean;
  /** Drop the lines' own top spacing, for a host that pads them itself (a floating card). */
  flush?: boolean;
}

/**
 * The success notice: settles in (motion-safe via useEntrance) and names where
 * the quote went. A polite live region announces it on Android and the web;
 * VoiceOver ignores live regions, so iOS is told explicitly.
 */
function PromotedNotice({ flush }: { flush: boolean }): React.JSX.Element {
  const settle = useEntrance();
  useEffect(() => announceOnIos(PROMOTED_NOTICE_COPY), []);
  return (
    <Animated.Text
      style={[styles.promotionSuccess, flush && styles.promotionFlush, settle]}
      testID="quote-promotion-success"
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      {PROMOTED_NOTICE_COPY}
    </Animated.Text>
  );
}

/** The failed-promote notice: a legible error line plus a same-anchors retry. */
function PromotionErrorNotice({
  hint,
  retryPromote,
  flush,
}: {
  hint: string;
  retryPromote: (() => Promise<void>) | null;
  flush: boolean;
}): React.JSX.Element {
  return (
    <>
      <Text
        style={[styles.promotionErrorText, flush && styles.promotionFlush]}
        testID="quote-promotion-error"
      >
        {hint}
      </Text>
      {retryPromote != null ? (
        <Button
          variant="tertiary"
          label="Try again"
          accessibilityLabel="Try again"
          testID="quote-promotion-retry"
          onPress={() => void retryPromote()}
        />
      ) : null}
    </>
  );
}

function PromotionFeedback({
  promoting,
  hint,
  promoted,
  retryPromote,
  showInflight = true,
  flush = false,
}: PromotionFeedbackProps): React.JSX.Element | null {
  if (promoting) {
    return showInflight ? (
      <Text
        style={[styles.promotionInflight, flush && styles.promotionFlush]}
        testID="quote-promotion-inflight"
      >
        {PROMOTING_COPY}
      </Text>
    ) : null;
  }
  if (hint != null) {
    return <PromotionErrorNotice hint={hint} retryPromote={retryPromote} flush={flush} />;
  }
  if (promoted) return <PromotedNotice flush={flush} />;
  return null;
}

/** Whether ``PromotionFeedback`` has anything to say right now (a host can skip its frame). */
export function hasPromotionFeedback({
  promoting,
  hint,
  promoted,
  showInflight = true,
}: Pick<PromotionFeedbackProps, 'promoting' | 'hint' | 'promoted' | 'showInflight'>): boolean {
  if (promoting) return showInflight;
  return hint != null || promoted;
}

export default PromotionFeedback;
