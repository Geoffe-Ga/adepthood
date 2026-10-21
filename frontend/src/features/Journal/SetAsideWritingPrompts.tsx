/** Recover today's writing invitations without putting prompt cards back on Journal. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useMorningPagesTipState } from './MorningPagesTip';
import ReflectionDismiss from './ReflectionDismiss';
import { reviewTitle } from './reviewScopes';
import type { DueReview } from './useDueReview';

import { useAuth } from '@/context/AuthContext';
import { BORDER_RADIUS, editorialType, ink, SPACING, surface } from '@/design/tokens';
import { todayInUserTZ } from '@/utils/dateUtils';

interface Props {
  review: DueReview | null;
  onRestoreReview: () => Promise<void>;
  refreshKey: number;
  onRestored: () => void;
}

function RecoveryCard({
  title,
  kind,
  onRestore,
}: {
  title: string;
  kind: 'review' | 'morning';
  onRestore: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.note}>{title}</Text>
      <ReflectionDismiss
        variant="reopen"
        label="Bring it back"
        textStyle={editorialType.action}
        accessibilityLabel={`Bring it back: ${title}`}
        testID={`notification-bring-back-${kind}`}
        onPress={onRestore}
      />
    </View>
  );
}

export default function SetAsideWritingPrompts({
  review,
  onRestoreReview,
  refreshKey,
  onRestored,
}: Props): React.JSX.Element | null {
  const { userTimezone } = useAuth();
  const { state, restore } = useMorningPagesTipState(undefined, refreshKey);
  const morning =
    state !== null && !state.neverOffer && state.setAsideOn === todayInUserTZ(userTimezone);
  if (review == null && !morning) return null;
  return (
    <View testID="prompts-set-aside-writing">
      <Text accessibilityRole="header" style={styles.heading}>
        Set aside
      </Text>
      {review == null ? null : (
        <RecoveryCard
          title={reviewTitle(review.scope, review.stageTitle)}
          kind="review"
          onRestore={() => void onRestoreReview()}
        />
      )}
      {morning ? (
        <RecoveryCard
          title="Morning pages"
          kind="morning"
          onRestore={() => {
            void restore().then((saved) => {
              if (saved) onRestored();
            });
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { ...editorialType.note, color: ink.muted, marginTop: SPACING.lg },
  note: { ...editorialType.note, color: ink.soft },
  card: {
    padding: SPACING.md,
    marginTop: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.sunken,
  },
});
