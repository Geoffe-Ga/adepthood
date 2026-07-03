/**
 * The two-up row of journal stat tiles under the hero. Each tile is ring-gated
 * by the user's depth preferences: a tile appears only when its ring is on, and
 * the whole row disappears when both rings are off (nothing to summarise).
 */
import React from 'react';
import { View } from 'react-native';

import HabitsStatTile from './HabitsStatTile';
import PracticesStatTile from './PracticesStatTile';
import s from './StatTile.styles';

import {
  selectEnableHabits,
  selectEnablePractices,
  useDepthPreferencesStore,
} from '@/store/useDepthPreferencesStore';

const StatTileRow = (): React.JSX.Element | null => {
  const habitsOn = useDepthPreferencesStore(selectEnableHabits);
  const practicesOn = useDepthPreferencesStore(selectEnablePractices);

  if (!habitsOn && !practicesOn) return null;

  return (
    <View style={s.row} testID="journal-stat-tile-row">
      {habitsOn ? <HabitsStatTile /> : null}
      {practicesOn ? <PracticesStatTile /> : null}
    </View>
  );
};

export default StatTileRow;
