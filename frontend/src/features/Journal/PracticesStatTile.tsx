/**
 * The journal "Practices" stat tile: this week's raw session count against the
 * weekly target. Shows a skeleton while loading and degrades to a countless but
 * still-pressable tile on error, so a failed fetch never crashes the shelf.
 */
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import React from 'react';

import StatTile from './StatTile';

import { WEEKLY_TARGET } from '@/features/Practice/constants';
import { useWeeklyProgress } from '@/features/Practice/hooks/useWeeklyProgress';
import type { RootTabParamList } from '@/navigation/BottomTabs';

type PracticesTileNav = BottomTabNavigationProp<RootTabParamList>;

const TITLE = 'Practices';
const CUE = 'Open practice →';

interface PracticesDescriptor {
  loading: boolean;
  stat?: string;
  accessibilityLabel: string;
}

/** Resolve the tile's stat and a11y label from the weekly-progress hook state. */
function describePractices(
  count: number,
  isLoading: boolean,
  error: Error | null,
): PracticesDescriptor {
  if (isLoading) {
    return { loading: true, accessibilityLabel: 'Practices this week, loading. Open practice' };
  }
  if (error !== null) {
    return {
      loading: false,
      accessibilityLabel: 'Practices this week, count unavailable. Open practice',
    };
  }
  return {
    loading: false,
    stat: `${count}/${WEEKLY_TARGET} this week`,
    accessibilityLabel: `Practices this week, ${count} of ${WEEKLY_TARGET} done. Open practice`,
  };
}

const PracticesStatTile = (): React.JSX.Element => {
  const navigation = useNavigation<PracticesTileNav>();
  const { count, isLoading, error } = useWeeklyProgress();
  const descriptor = describePractices(count, isLoading, error);

  return (
    <StatTile
      testID="journal-practices-tile"
      title={TITLE}
      cue={CUE}
      stat={descriptor.stat}
      loading={descriptor.loading}
      accessibilityLabel={descriptor.accessibilityLabel}
      onPress={() => navigation.navigate('Practice')}
    />
  );
};

export default PracticesStatTile;
