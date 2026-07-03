/**
 * A single half-width journal stat tile: a pressable paper card showing a
 * caption title, an optional stat line (or a loading skeleton), and an accent
 * cue. Purely presentational — parents own the data and the press action.
 */
import React from 'react';
import { Pressable, Text } from 'react-native';

import s, { SKELETON_HEIGHT, SKELETON_WIDTH } from './StatTile.styles';

import { Skeleton } from '@/components/feedback/Skeleton';

interface StatTileProps {
  title: string;
  cue: string;
  onPress: () => void;
  accessibilityLabel: string;
  testID: string;
  loading?: boolean;
  stat?: string;
}

/** Render the tile's middle line: a skeleton while loading, else the stat text. */
function StatBody({
  loading,
  stat,
  testID,
}: Pick<StatTileProps, 'loading' | 'stat' | 'testID'>): React.JSX.Element | null {
  if (loading) {
    return (
      <Skeleton testID={`${testID}-skeleton`} width={SKELETON_WIDTH} height={SKELETON_HEIGHT} />
    );
  }
  if (stat) return <Text style={s.stat}>{stat}</Text>;
  return null;
}

const StatTile = ({
  title,
  cue,
  onPress,
  accessibilityLabel,
  testID,
  loading = false,
  stat,
}: StatTileProps): React.JSX.Element => (
  <Pressable
    style={s.tile}
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel}
    testID={testID}
  >
    <Text style={s.title}>{title}</Text>
    <StatBody loading={loading} stat={stat} testID={testID} />
    <Text style={s.cue}>{cue}</Text>
  </Pressable>
);

export default StatTile;
