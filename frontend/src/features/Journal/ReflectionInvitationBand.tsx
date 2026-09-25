/**
 * ``ReflectionInvitationBand`` — the card that offers a review on the day it
 * comes round. Presentational since issue #2867: ``JournalPrimaryInvitation``
 * decides WHETHER a review is the shelf's call to write (and fetches it); this
 * only draws it, under the same testIDs the browser specs press.
 *
 * "You choose your depth": a warm, one-tap-declinable invitation — never a gate
 * and never gamified. There is deliberately no streak, no count, and no guilt
 * copy.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import ReflectionDismiss from './ReflectionDismiss';
import {
  REVIEW_BAND_LABEL,
  REVIEW_DISMISS,
  REVIEW_DISMISS_A11Y,
  REVIEW_INVITE_SUBLINE,
  REVIEW_RESUME_SUBLINE,
  reviewCtaA11y,
  writeReviewCta,
} from './reviewInvitationCopy';
import { reviewTitle } from './reviewScopes';
import type { DueReview } from './useDueReview';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

/** The band's identifying warm left rule (matches the weekly-prompt band), in dp. */
const ACCENT_BAR_WIDTH = 3;

export interface ReflectionInvitationBandProps {
  review: DueReview;
  onOpen: () => void;
  onDismiss: () => void;
}

function ReflectionInvitationBand({
  review,
  onOpen,
  onDismiss,
}: ReflectionInvitationBandProps): React.JSX.Element {
  const { scope, stageTitle } = review;
  const title = reviewTitle(scope, stageTitle);
  const resuming = scope.existing_entry_id != null;

  // A plain container, not a pressable, so the inner "open" and "decline"
  // buttons stay independently reachable by assistive tech (a pressable wrapper
  // would collapse the subtree and hide the one-tap decline). Mirrors the
  // ``InvitationNote`` card shape.
  return (
    <View style={styles.band}>
      <TouchableOpacity
        style={styles.openArea}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={reviewCtaA11y(scope.level, title, resuming)}
        testID="journal-reflection-band"
      >
        <Text style={styles.label}>{REVIEW_BAND_LABEL}</Text>
        <Text style={styles.title}>{writeReviewCta(scope.level)}</Text>
        <Text style={styles.scope}>{title}</Text>
        <Text style={styles.subline}>
          {resuming ? REVIEW_RESUME_SUBLINE : REVIEW_INVITE_SUBLINE}
        </Text>
      </TouchableOpacity>
      <ReflectionDismiss
        label={REVIEW_DISMISS}
        accessibilityLabel={REVIEW_DISMISS_A11Y}
        testID="journal-reflection-dismiss"
        onPress={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    // A raised sheet with the same warm accent rule as the morning-pages tip it
    // stands in for, so the shelf's primary invitation keeps one treatment.
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_BAR_WIDTH,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  openArea: {
    minHeight: touchTarget.minimum,
  },
  label: {
    ...editorialType.caption,
    color: ink.muted,
  },
  title: {
    ...editorialType.heading,
    color: ink.primary,
    paddingTop: spacing(0.5),
  },
  scope: {
    ...editorialType.body,
    color: ink.primary,
    paddingTop: spacing(0.5),
  },
  subline: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
});

export default ReflectionInvitationBand;
