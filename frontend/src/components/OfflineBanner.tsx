import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useNetworkStatus } from '@/context/NetworkStatusContext';
import { colors, SPACING } from '@/design/tokens';

/**
 * BUG-FRONTEND-INFRA-005 — always-visible hint when connectivity drops.
 *
 * The banner renders outside any single feature so users aren't guessing
 * whether their action failed because of an outage or a real server
 * rejection. Placed below the status bar by the root layout.
 */
export function OfflineBanner(): React.JSX.Element | null {
  const { isOnline } = useNetworkStatus();
  if (isOnline) return null;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLabel="You are offline"
      style={styles.banner}
      testID="offline-banner"
    >
      <Text style={styles.text}>You're offline — changes will sync when you reconnect.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.danger,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    alignItems: 'center',
  },
  text: {
    color: colors.text.light,
    fontSize: 13,
    fontWeight: '600',
  },
});
