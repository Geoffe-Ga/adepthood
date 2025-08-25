import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { STAGE_COLORS } from '../../constants/stageColors';
import { spacing } from '../../Sources/design/DesignSystem';
import useResponsive from '../../Sources/design/useResponsive';

import type { HabitTileProps } from './Habits.types';
import {
  calculateProgressPercentage,
  clampPercentage,
  getGoalTier,
  getMarkerPositions,
  getProgressBarColor,
  getTierColor,
} from './HabitUtils';

export const HabitTile = ({ habit, onOpenGoals, onLongPress, onIconPress }: HabitTileProps) => {
  const { width, height, columns, scale, gridGutter } = useResponsive();
  const stageColor = STAGE_COLORS[habit.stage];

  const lowGoal = habit.goals.find((g) => g.tier === 'low');
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');

  const { currentGoal, nextGoal, completedAllGoals } = getGoalTier(habit);
  const progressPercentage = clampPercentage(
    calculateProgressPercentage(habit, currentGoal, nextGoal),
  );
  const progressBarColor = getProgressBarColor(habit);
  const hasCompletedGoal = completedAllGoals || progressPercentage >= 100;
  const streakText =
    `${habit.streak} days${hasCompletedGoal ? ' — Achieved Today!' : ''}`.toUpperCase();

  const barHeight = Math.max(8, spacing(2, scale));
  const rows = columns === 2 ? 5 : 10;
  const tileMinHeight = height / rows - 2 * spacing(1, scale) - gridGutter;
  const tileWidth = width / columns;
  const iconInline = columns === 1 || tileWidth < 400;

  const {
    low: lowMarker,
    clear: clearMarker,
    stretch: stretchMarker,
  } = getMarkerPositions(lowGoal, clearGoal, stretchGoal);

  return (
    <TouchableOpacity
      testID="habit-tile"
      style={{
        flex: 1,
        borderWidth: 1,
        borderColor: stageColor,
        padding: spacing(1, scale),
        margin: gridGutter / 2,
        minHeight: tileMinHeight,
        borderRadius: spacing(1, scale),
        backgroundColor: '#f8f8f8',
      }}
      onPress={onOpenGoals}
      onLongPress={onLongPress}
    >
      {iconInline ? (
        <View testID="habit-header" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text
            style={{ fontSize: spacing(3, scale), marginRight: spacing(1, scale) }}
            onPress={onIconPress}
            testID="habit-icon"
          >
            {habit.icon}
          </Text>
          <Text
            style={{
              flex: 1,
              fontSize: spacing(2, scale),
              fontWeight: '700',
              textTransform: 'uppercase',
            }}
          >
            {habit.name}
          </Text>
          <Text
            style={[
              { fontSize: spacing(1.5, scale), textTransform: 'uppercase' },
              hasCompletedGoal && {
                backgroundColor: stageColor,
                color: '#fff',
                paddingHorizontal: spacing(0.5, scale),
                borderRadius: spacing(0.5, scale),
              },
            ]}
          >
            {streakText}
          </Text>
        </View>
      ) : (
        <>
          <View
            testID="habit-icon-top"
            style={{ alignItems: 'center', marginBottom: spacing(1, scale) }}
          >
            <Text
              style={{ fontSize: spacing(4, scale) }}
              onPress={onIconPress}
              testID="habit-icon-top-text"
            >
              {habit.icon}
            </Text>
          </View>
          <View testID="habit-header" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text
              style={{
                flex: 1,
                fontSize: spacing(2, scale),
                fontWeight: '700',
                textTransform: 'uppercase',
              }}
            >
              {habit.name}
            </Text>
            <Text
              style={[
                { fontSize: spacing(1.5, scale), textTransform: 'uppercase' },
                hasCompletedGoal && {
                  backgroundColor: stageColor,
                  color: '#fff',
                  paddingHorizontal: spacing(0.5, scale),
                  borderRadius: spacing(0.5, scale),
                },
              ]}
            >
              {streakText}
            </Text>
          </View>
        </>
      )}

      <View style={{ marginTop: spacing(1, scale) }}>
        <View
          style={{
            height: barHeight,
            backgroundColor: '#eee',
            borderRadius: barHeight / 2,
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          {lowGoal && lowMarker >= 0 && (
            <View
              style={{
                position: 'absolute',
                left: `${clampPercentage(lowMarker)}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: getTierColor('low'),
              }}
            />
          )}
          {clearGoal && clearMarker >= 0 && (
            <View
              style={{
                position: 'absolute',
                left: `${clampPercentage(clearMarker)}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: getTierColor('clear'),
              }}
            />
          )}
          {stretchGoal && stretchMarker >= 0 && (
            <View
              style={{
                position: 'absolute',
                left: `${clampPercentage(stretchMarker)}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: getTierColor('stretch'),
              }}
            />
          )}
          <View
            testID="progress-fill"
            style={{
              height: '100%',
              width: `${progressPercentage}%`,
              backgroundColor: progressBarColor,
            }}
          />
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default HabitTile;
