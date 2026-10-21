import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useReportNotificationPresence } from './notificationPresence';
import ReflectionDismiss, { closeCornerReserve } from './ReflectionDismiss';
import {
  REVIEW_EARLY_A11Y,
  REVIEW_EARLY_BODY,
  REVIEW_EARLY_CLOSE,
  REVIEW_EARLY_CLOSE_A11Y,
  REVIEW_EARLY_DISMISS_A11Y,
  REVIEW_EARLY_LINK,
  REVIEW_EARLY_RESTORE,
  REVIEW_EARLY_SET_ASIDE,
  REVIEW_EARLY_TITLE,
} from './reviewInvitationCopy';
import ReviewScopePicker, { type ReviewScopePickerProps } from './ReviewScopePicker';
import { useEarlyReviewDismissal } from './useEarlyReviewDismissal';

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
import { useAccountScope } from '@/storage/useActiveUser';
import { moveAccessibilityFocus } from '@/utils/accessibilityFocus';

/** The same warm left rule as the Morning Pages invitation. */
const ACCENT_BAR_WIDTH = 3;

interface EarlyReviewCardProps extends ReviewScopePickerProps {
  actionRef: React.RefObject<View | null>;
  onToggle: () => void;
}

function useCardActions({ actionRef, enabled, onToggle, refreshKey }: EarlyReviewCardProps) {
  const { dismissed, change } = useEarlyReviewDismissal(refreshKey);
  const { epoch } = useAccountScope();
  const [focusRequest, setFocusRequest] = useState<{ epoch: number } | null>(null);
  useEffect(() => {
    if (focusRequest?.epoch === epoch) moveAccessibilityFocus(actionRef.current);
  }, [focusRequest, epoch, actionRef]);
  const choose = (value: boolean) => {
    if (value && enabled) onToggle();
    void change(value).then((saved) => {
      if (saved) setFocusRequest({ epoch });
    });
  };
  return { dismissed, dismiss: () => choose(true), restore: () => choose(false) };
}

function SetAsideReview({
  actionRef,
  onRestore,
}: {
  actionRef: React.RefObject<View | null>;
  onRestore: () => void;
}) {
  return (
    <View style={styles.recovery}>
      <Text style={styles.body}>{REVIEW_EARLY_SET_ASIDE}</Text>
      <Button
        ref={actionRef}
        variant="tertiary"
        label={REVIEW_EARLY_RESTORE}
        testID="journal-review-early-restore"
        onPress={onRestore}
        style={styles.action}
      />
    </View>
  );
}

/** A declinable invitation, with the explanation and choices in one card. */
export default function EarlyReviewCard(props: EarlyReviewCardProps): React.JSX.Element | null {
  const { actionRef, enabled, onToggle, refreshKey, onChoose } = props;
  const { dismissed, dismiss, restore } = useCardActions(props);
  useReportNotificationPresence('earlyReview', dismissed === false, dismissed === false ? 1 : 0);
  if (dismissed === null) return null;
  if (dismissed) return <SetAsideReview actionRef={actionRef} onRestore={restore} />;
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
      <ReflectionDismiss
        variant="close"
        accessibilityLabel={REVIEW_EARLY_DISMISS_A11Y}
        testID="journal-review-early-dismiss"
        onPress={dismiss}
      />
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
    marginRight: closeCornerReserve(SPACING.lg),
  },
  body: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(1),
  },
  recovery: {
    marginTop: SPACING.lg,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.sunken,
  },
  // The action shares the explanation's edge within the card.
  action: {
    marginTop: SPACING.sm,
    paddingHorizontal: 0,
    justifyContent: 'flex-start',
  },
});
