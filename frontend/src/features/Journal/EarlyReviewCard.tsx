import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  REVIEW_EARLY_A11Y,
  REVIEW_EARLY_BODY,
  REVIEW_EARLY_CLOSE,
  REVIEW_EARLY_CLOSE_A11Y,
  REVIEW_EARLY_LINK,
  REVIEW_EARLY_TITLE,
} from './reviewInvitationCopy';
import ReviewScopePicker, { type ReviewScopePickerProps } from './ReviewScopePicker';

import { Button } from '@/components/Button';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
} from '@/design/tokens';

/** The same warm left rule as the Morning Pages invitation. */
const ACCENT_BAR_WIDTH = 3;

interface EarlyReviewCardProps extends ReviewScopePickerProps {
  actionRef: React.Ref<View>;
  onToggle: () => void;
}

/** A persistent door into reviews, with the explanation and choices in one card. */
export default function EarlyReviewCard({
  actionRef,
  enabled,
  onToggle,
  refreshKey,
  onChoose,
}: EarlyReviewCardProps): React.JSX.Element {
  return (
    <View style={styles.card} testID="journal-review-early-card">
      <Text style={styles.title}>{REVIEW_EARLY_TITLE}</Text>
      <Text style={styles.body}>{REVIEW_EARLY_BODY}</Text>
      <Button
        ref={actionRef}
        variant="tertiary"
        label={enabled ? REVIEW_EARLY_CLOSE : REVIEW_EARLY_LINK}
        accessibilityLabel={enabled ? REVIEW_EARLY_CLOSE_A11Y : REVIEW_EARLY_A11Y}
        testID="journal-review-early"
        onPress={onToggle}
        style={styles.action}
      />
      <ReviewScopePicker enabled={enabled} refreshKey={refreshKey} onChoose={onChoose} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_BAR_WIDTH,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  title: {
    ...editorialType.heading,
    color: ink.primary,
  },
  body: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
  // The action shares the explanation's edge within the card.
  action: {
    marginTop: SPACING.sm,
    paddingHorizontal: 0,
    justifyContent: 'flex-start',
  },
});
