/**
 * ``ChapterPromotionNotice`` -- what a chapter's promote says, where the reader
 * is looking (#3660).
 *
 * A journal page sets its promote notice under the body, but a chapter's
 * selection field can be screens long, so its notice floats instead: a small
 * card in the band the Promote pill rides in, centred over the column. Once a
 * quote lands the passage clears and the pill withdraws, so the notice settles
 * in exactly where the pill was. While a passage is still chosen -- a failed
 * promote keeps it, for a retry -- the card lifts one pill above, so the two
 * never overlap. The pill shows a promote in flight itself, so the card has
 * nothing to say until one settles.
 *
 * The words and their order are the shared ``PromotionFeedback``'s, so a reader
 * meets the same notice on a chapter as on a page.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { RESONANCE_BUTTON_CLEARANCE } from '../Journal/JournalEntry.styles';
import PromotionFeedback, { hasPromotionFeedback } from '../Journal/PromotionFeedback';

import type { ChapterPromotionFeedback } from './useChapterPromotion';

import { BORDER_RADIUS, SPACING, floatingChrome, touchTarget } from '@/design/tokens';

/** How far above the pill's band a lifted card sits: one pill and the row's gap. */
const LIFTED_CLEARANCE = RESONANCE_BUTTON_CLEARANCE + touchTarget.minimum + SPACING.sm;

/** The card's widest measure, so a long error wraps into a readable column on a desktop. */
const NOTICE_MAX_WIDTH = 480;

/** Above the selection field and its pinned footer, like the pill's own layer. */
const NOTICE_LAYER = 1;

export interface ChapterPromotionNoticeProps {
  feedback: ChapterPromotionFeedback;
  /** A passage is chosen, so the pill is up: sit one pill above it. */
  lifted: boolean;
}

function ChapterPromotionNotice({
  feedback,
  lifted,
}: ChapterPromotionNoticeProps): React.JSX.Element | null {
  if (!hasPromotionFeedback({ ...feedback, showInflight: false })) return null;
  return (
    <View
      style={[styles.band, lifted && styles.lifted]}
      pointerEvents="box-none"
      testID="chapter-promotion-notice"
    >
      <View style={styles.card}>
        <PromotionFeedback {...feedback} showInflight={false} flush />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: RESONANCE_BUTTON_CLEARANCE,
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    zIndex: NOTICE_LAYER,
  },
  lifted: {
    bottom: LIFTED_CLEARANCE,
  },
  card: {
    ...floatingChrome.pill,
    maxWidth: NOTICE_MAX_WIDTH,
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.lg,
  },
});

export default ChapterPromotionNotice;
