import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { EnergyHandoffStatus } from '../hooks/useEnergyOnboardingIntent';

import { accent, BORDER_RADIUS, colors, ink, SPACING, surface, touchTarget } from '@/design/tokens';

const WAITING_COPY = 'Energy Scaffolding will open once your habits have loaded.';
const FAILED_COPY =
  "We couldn't load your habits, so Energy Scaffolding hasn't opened yet. It will open once they load.";

interface EnergyHandoffNoticeProps {
  status: EnergyHandoffStatus;
  /** False when the screen's error banner already offers the same retry. */
  showRetry: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

/**
 * Say why the Energy Scaffolding the user asked for from Course has not
 * opened yet (#3328). The review it opens on asks about the habits the
 * account already has, so it waits for the server's list rather than asking a
 * returning user about nothing; this line keeps that wait honest, offers a
 * retry when the read failed, and lets the user decline in one tap.
 */
export default function EnergyHandoffNotice({
  status,
  showRetry,
  onRetry,
  onCancel,
}: EnergyHandoffNoticeProps): React.JSX.Element | null {
  if (status === 'idle') return null;
  const message = status === 'failed' ? FAILED_COPY : WAITING_COPY;
  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={message}
      style={styles.notice}
      testID="energy-handoff-notice"
    >
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        {status === 'failed' && showRetry && (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={onRetry}
            style={styles.action}
            testID="energy-handoff-retry"
          >
            <Text style={styles.retryLabel}>Try again</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          accessibilityRole="button"
          onPress={onCancel}
          style={styles.action}
          testID="energy-handoff-cancel"
        >
          <Text style={styles.cancelLabel}>Not now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// The same recessed well as DroppedCheckInNotice: information about a wait,
// not an alarm, so it stays quieter than the red ErrorBanner.
const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: SPACING.sm,
    backgroundColor: surface.sunken,
    borderLeftWidth: SPACING.xs,
    borderLeftColor: colors.warning,
    borderRadius: BORDER_RADIUS.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    // Inset to the error banner's and the Energy footer's edges, so the three
    // read as one column on every width.
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  message: {
    flexShrink: 1,
    flexGrow: 1,
    flexBasis: 0,
    minWidth: '60%',
    color: ink.primary,
  },
  actions: {
    flexDirection: 'row',
    marginLeft: 'auto',
  },
  action: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  retryLabel: {
    color: accent.strong,
    fontWeight: '600',
  },
  cancelLabel: {
    color: ink.soft,
    fontWeight: '600',
  },
});
