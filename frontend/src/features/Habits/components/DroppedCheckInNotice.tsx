import React, { useCallback } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { habitManager } from '../services/habitManager';

import { BORDER_RADIUS, colors, ink, SPACING, surface, touchTarget } from '@/design/tokens';
import { useDroppedCheckInStore } from '@/store/useDroppedCheckInStore';

/** Copy for the loss, singular or plural on the count. */
const noticeMessage = (count: number): string =>
  `${count} offline check-in${count === 1 ? '' : 's'} could not be saved.`;

/**
 * Quiet, non-modal report that a queued offline check-in was permanently
 * rejected and dropped from the replay queue.
 *
 * A banner rather than a toast: ``loadHabits`` re-runs on every zone change
 * and internal re-fetch, so a toast would re-fire for one historical loss
 * until the user happened to be looking. Not an ``Alert.alert`` either — that
 * is a documented no-op on React Native Web mobile, and this is information,
 * not a decision the user has to make now. It self-subscribes to the
 * quarantine store, so it renders nothing until a check-in is actually lost
 * and retracts itself once the quarantine is cleared.
 */
export default function DroppedCheckInNotice(): React.JSX.Element | null {
  const entries = useDroppedCheckInStore((state) => state.entries);
  const onDismiss = useCallback(() => {
    void habitManager.dismissDroppedCheckIns();
  }, []);

  if (entries.length === 0) return null;
  const message = noticeMessage(entries.length);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel={message}
      style={styles.notice}
      testID="dropped-check-in-notice"
    >
      <Text style={styles.message}>{message}</Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        style={styles.dismiss}
        testID="dismiss-dropped-check-ins"
      >
        <Text style={styles.dismissLabel}>Dismiss</Text>
      </TouchableOpacity>
    </View>
  );
}

// Informational, not alarming: the recessed Candle-and-Ink well with a warm
// ``warning`` rule, deliberately quieter than the red ErrorBanner, because
// nothing here is retryable and nothing is the user's to fix.
const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: surface.sunken,
    borderLeftWidth: SPACING.xs,
    borderLeftColor: colors.warning,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginBottom: SPACING.sm,
  },
  message: {
    flexShrink: 1,
    color: ink.primary,
  },
  dismissLabel: {
    color: ink.soft,
    fontWeight: '600',
  },
  dismiss: {
    // A short label still needs the WCAG 2.5.5 hit area.
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
});
