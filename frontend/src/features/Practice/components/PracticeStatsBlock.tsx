/**
 * `PracticeStatsBlock` — "how much have I put into this practice", on the
 * practice detail screen (#2449).
 *
 * Renders through the shared `StatRow` / `StatList` primitives the Habits stats
 * modal uses, so a practitioner reads their practice totals in the same shape
 * as their habit totals rather than in a second dialect invented here.
 *
 * Absent, not empty, when there is nothing to report: a practice the user has
 * not adopted shows no block at all. Depth is chosen, never urged, so a screen
 * someone is only browsing does not open with a tally of what they have not
 * done.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PracticeStatsResponse } from '@/api';
import { StatList, StatRow } from '@/components/StatRow';
import { SPACING, ink } from '@/design/tokens';
import { formatTotalMinutes } from '@/features/Practice/utils/formatTotalMinutes';

export interface PracticeStatsBlockProps {
  stats: PracticeStatsResponse | null;
}

export const PracticeStatsBlock = ({
  stats,
}: PracticeStatsBlockProps): React.JSX.Element | null => {
  if (stats === null) return null;
  return (
    <View style={styles.block}>
      <Text style={styles.heading}>YOUR PRACTICE</Text>
      <StatList testID="practice-detail-stats">
        <StatRow
          label="Total sessions"
          value={`${stats.total_sessions}`}
          valueTestID="practice-detail-total-sessions"
        />
        <StatRow
          label="Total time"
          value={formatTotalMinutes(stats.total_minutes)}
          valueTestID="practice-detail-total-time"
        />
      </StatList>
    </View>
  );
};

const styles = StyleSheet.create({
  block: { marginBottom: SPACING.md },
  heading: {
    fontSize: 12,
    fontWeight: '700',
    color: ink.soft,
    letterSpacing: 1,
  },
});

export default PracticeStatsBlock;
