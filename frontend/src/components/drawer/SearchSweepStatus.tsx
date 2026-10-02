/**
 * The quiet inline status a screen drawer shows beneath its search field while a
 * confirmed deep (body) search is active: a "searching..." caption while the
 * confirm-triggered sweep runs, or a failure caption plus a retry row if it
 * failed. It keeps the sweep's in-flight and error states visible without
 * leaving the results view, which would otherwise swallow both until the query
 * is cleared.
 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import DrawerItem from './DrawerItem';

import { SPACING, accent, ink, type } from '@/design/tokens';

/** Progress of a drawer's confirm-gated deep-search sweep. */
export type SweepStatus = 'idle' | 'loading' | 'error';

/** Retry affordance shown alongside the sweep-error caption. */
export const SWEEP_RETRY_LABEL = 'Tap to retry';

/**
 * Fold a pair of in-flight/failed flags into one sweep status. In-flight wins
 * when both are set: a retry that is already running supersedes the failure it
 * is retrying, so the caption says "searching", not "could not finish".
 */
export function sweepStatusFrom(loading: boolean, error: boolean): SweepStatus {
  if (loading) return 'loading';
  if (error) return 'error';
  return 'idle';
}

export interface SearchSweepStatusProps {
  /** True once the deep body search is confirmed; gates the sweep's status. */
  active: boolean;
  /** Current progress of the confirm-triggered sweep. */
  status: SweepStatus;
  /** Re-run the sweep after a failure. */
  onRetry: () => void;
  /** Prefix for the `-loading`, `-error` and `-retry` test hooks. */
  testIDPrefix: string;
  /** Caption shown while the sweep is in flight. */
  loadingLabel: string;
  /** Caption shown above the retry row when the sweep failed. */
  errorLabel: string;
}

/** The sweep's loading row or error block; nothing while inactive or idle. */
export default function SearchSweepStatus({
  active,
  status,
  onRetry,
  testIDPrefix,
  loadingLabel,
  errorLabel,
}: SearchSweepStatusProps): React.JSX.Element | null {
  const { width } = useWindowDimensions();
  if (!active) return null;
  if (status === 'loading') {
    return (
      <View testID={`${testIDPrefix}-loading`} style={styles.searchStatusRow}>
        <ActivityIndicator size="small" color={accent.primary} />
        <Text style={[type(width).caption, styles.searchStatusText]}>{loadingLabel}</Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View testID={`${testIDPrefix}-error`} style={styles.searchStatusBlock}>
        <Text style={[type(width).caption, styles.searchStatusText]}>{errorLabel}</Text>
        <DrawerItem testID={`${testIDPrefix}-retry`} label={SWEEP_RETRY_LABEL} onPress={onRetry} />
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  searchStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  searchStatusBlock: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    gap: SPACING.xs,
  },
  searchStatusText: {
    color: ink.muted,
  },
});
