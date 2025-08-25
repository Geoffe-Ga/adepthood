import React from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';

import { STAGE_COLORS } from '../../constants/stageColors';
import { spacing } from '../../Sources/design/DesignSystem';
import useResponsive from '../../Sources/design/useResponsive';

import type { HabitTileProps, Goal } from './Habits.types';
import {
  getProgressPercentage,
  clampPercentage,
  getGoalTier,
  getMarkerPositions,
  getProgressBarColor,
  getTierColor,
} from './HabitUtils';

export const HabitTile = ({ habit, onOpenGoals, onLongPress }: HabitTileProps) => {
  const { width, height, columns, scale, gridGutter } = useResponsive();
  const formatGoalTooltip = (g: Goal) =>
    `${g.target} ${g.target_unit} ${g.frequency_unit.replace('_', ' ')}`;
  const stageColor = STAGE_COLORS[habit.stage];

  const lowGoal = habit.goals.find((g) => g.tier === 'low');
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');

  const { currentGoal, nextGoal, completedAllGoals } = getGoalTier(habit);
  const progressPercentage = clampPercentage(getProgressPercentage(habit, currentGoal, nextGoal));
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
          <Text style={{ fontSize: spacing(3, scale), marginRight: spacing(1, scale) }}>
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
            <Text style={{ fontSize: spacing(4, scale) }}>{habit.icon}</Text>
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
          <View
            testID="progress-fill"
            style={{
              height: '100%',
              width: `${progressPercentage}%`,
              backgroundColor: progressBarColor,
            }}
          />
          {lowGoal && lowMarker >= 0 && (
            <TouchableOpacity
              style={{
                position: 'absolute',
                left: `${clampPercentage(lowMarker)}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: getTierColor('low'),
                zIndex: 1,
                transform: [
                  {
                    translateX:
                      clampPercentage(lowMarker) === 0
                        ? 0
                        : clampPercentage(lowMarker) === 100
                          ? -2
                          : -1,
                  },
                ],
              }}
              onLongPress={() => Alert.alert('Low Grit', formatGoalTooltip(lowGoal))}
            />
          )}
          {clearGoal && clearMarker >= 0 && (
            <TouchableOpacity
              style={{
                position: 'absolute',
                left: `${clampPercentage(clearMarker)}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: getTierColor('clear'),
                zIndex: 2,
                transform: [
                  {
                    translateX:
                      clampPercentage(clearMarker) === 0
                        ? 0
                        : clampPercentage(clearMarker) === 100
                          ? -2
                          : -1,
                  },
                ],
              }}
              onLongPress={() => Alert.alert('Clear Goal', formatGoalTooltip(clearGoal))}
            />
          )}
          {stretchGoal && stretchMarker >= 0 && (
            <TouchableOpacity
              style={{
                position: 'absolute',
                left: `${clampPercentage(stretchMarker)}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: getTierColor('stretch'),
                zIndex: 3,
                transform: [
                  {
                    translateX:
                      clampPercentage(stretchMarker) === 0
                        ? 0
                        : clampPercentage(stretchMarker) === 100
                          ? -2
                          : -1,
                  },
                ],
              }}
              onLongPress={() => Alert.alert('Stretch Goal', formatGoalTooltip(stretchGoal))}
            />
          )}
        </View>
        <View style={{ position: 'relative', marginTop: spacing(0.5, scale) }}>
          {lowGoal && lowMarker >= 0 && (
            <Text
              style={{
                position: 'absolute',
                left: `${clampPercentage(lowMarker)}%`,
                transform: [
                  {
                    translateX:
                      clampPercentage(lowMarker) === 0
                        ? 0
                        : clampPercentage(lowMarker) === 100
                          ? -12
                          : -6,
                  },
                ],
                fontSize: spacing(1.5, scale),
                color: getTierColor('low'),
                zIndex: 1,
              }}
            >
              LG
            </Text>
          )}
          {clearGoal && clearMarker >= 0 && (
            <Text
              style={{
                position: 'absolute',
                left: `${clampPercentage(clearMarker)}%`,
                transform: [
                  {
                    translateX:
                      clampPercentage(clearMarker) === 0
                        ? 0
                        : clampPercentage(clearMarker) === 100
                          ? -12
                          : -6,
                  },
                ],
                fontSize: spacing(1.5, scale),
                color: getTierColor('clear'),
                zIndex: 2,
              }}
            >
              CG
            </Text>
          )}
          {stretchGoal && stretchMarker >= 0 && (
            <Text
              style={{
                position: 'absolute',
                left: `${clampPercentage(stretchMarker)}%`,
                transform: [
                  {
                    translateX:
                      clampPercentage(stretchMarker) === 0
                        ? 0
                        : clampPercentage(stretchMarker) === 100
                          ? -12
                          : -6,
                  },
                ],
                fontSize: spacing(1.5, scale),
                color: getTierColor('stretch'),
                zIndex: 3,
              }}
            >
              SG
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default HabitTile;
