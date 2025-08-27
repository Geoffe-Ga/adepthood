import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

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
  isGoalAchieved,
  calculateHabitProgress,
} from './HabitUtils';

export const HabitTile = ({ habit, onOpenGoals, onLongPress }: HabitTileProps) => {
  const { width, height, columns, scale, gridGutter } = useResponsive();
  const formatGoalTooltip = (g: Goal) => {
    const label =
      g.tier === 'low' ? 'Low Grit' : g.tier === 'clear' ? 'Clear Goal' : 'Stretch Goal';
    const progress = calculateHabitProgress(habit);
    return `${label}: ${progress}/${g.target} ${g.target_unit}`;
  };
  const stageColor = STAGE_COLORS[habit.stage];

  const [tooltip, setTooltip] = useState<null | 'low' | 'clear' | 'stretch'>(null);

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
  const hasCleared = clearGoal ? isGoalAchieved(clearGoal, habit) : false;

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
        <View style={{ height: barHeight, position: 'relative' }}>
          <View
            style={{
              height: '100%',
              backgroundColor: '#eee',
              borderRadius: barHeight / 2,
              overflow: 'hidden',
            }}
          >
            <View
              testID="progress-fill"
              style={{
                height: '100%',
                width: `${progressPercentage}%`,
                backgroundColor: progressBarColor,
                borderRadius: barHeight / 2,
              }}
            />
          </View>
          {lowGoal && lowMarker >= 0 && (
            <View
              style={{
                position: 'absolute',
                left: `${clampPercentage(lowMarker)}%`,
                top: -6 + barHeight / 2,
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
                zIndex: 1,
                alignItems: 'center',
              }}
            >
              {tooltip === 'low' && (
                <View
                  testID="tooltip-low"
                  style={{
                    position: 'absolute',
                    bottom: 16,
                    backgroundColor: '#fffdf7',
                    borderWidth: 1,
                    borderColor: getTierColor('low'),
                    borderRadius: 4,
                    paddingHorizontal: 4,
                    paddingVertical: 2,
                  }}
                >
                  <Text
                    style={{
                      fontSize: spacing(1.5, scale),
                      color: '#333',
                      fontFamily: 'serif',
                      fontStyle: 'italic',
                      letterSpacing: 0.5,
                    }}
                  >
                    {formatGoalTooltip(lowGoal)}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                testID="marker-low"
                onPressIn={() => setTooltip('low')}
                onPressOut={() => setTooltip(null)}
                // @ts-ignore react-native-web hover props
                onMouseEnter={() => setTooltip('low')}
                // @ts-ignore react-native-web hover props
                onMouseLeave={() => setTooltip(null)}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: '#fffdf7',
                  borderWidth: 2,
                  borderColor: getTierColor('low'),
                }}
              />
            </View>
          )}
          {clearGoal && clearMarker >= 0 && (
            <View
              style={{
                position: 'absolute',
                left: `${clampPercentage(clearMarker)}%`,
                top: -6 + barHeight / 2,
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
                zIndex: 2,
                alignItems: 'center',
              }}
            >
              {tooltip === 'clear' && (
                <View
                  testID="tooltip-clear"
                  style={{
                    position: 'absolute',
                    bottom: 16,
                    backgroundColor: '#fffdf7',
                    borderWidth: 1,
                    borderColor: getTierColor('clear'),
                    borderRadius: 4,
                    paddingHorizontal: 4,
                    paddingVertical: 2,
                  }}
                >
                  <Text
                    style={{
                      fontSize: spacing(1.5, scale),
                      color: '#333',
                      fontFamily: 'serif',
                      fontStyle: 'italic',
                      letterSpacing: 0.5,
                    }}
                  >
                    {formatGoalTooltip(clearGoal)}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                testID="marker-clear"
                onPressIn={() => setTooltip('clear')}
                onPressOut={() => setTooltip(null)}
                // @ts-ignore react-native-web hover props
                onMouseEnter={() => setTooltip('clear')}
                // @ts-ignore react-native-web hover props
                onMouseLeave={() => setTooltip(null)}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: '#fffdf7',
                  borderWidth: 2,
                  borderColor: getTierColor('clear'),
                }}
              />
            </View>
          )}
          {stretchGoal && stretchMarker >= 0 && hasCleared && (
            <View
              style={{
                position: 'absolute',
                left: `${clampPercentage(stretchMarker)}%`,
                top: -6 + barHeight / 2,
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
                zIndex: 3,
                alignItems: 'center',
              }}
            >
              {tooltip === 'stretch' && (
                <View
                  testID="tooltip-stretch"
                  style={{
                    position: 'absolute',
                    bottom: 16,
                    backgroundColor: '#fffdf7',
                    borderWidth: 1,
                    borderColor: getTierColor('stretch'),
                    borderRadius: 4,
                    paddingHorizontal: 4,
                    paddingVertical: 2,
                  }}
                >
                  <Text
                    style={{
                      fontSize: spacing(1.5, scale),
                      color: '#333',
                      fontFamily: 'serif',
                      fontStyle: 'italic',
                      letterSpacing: 0.5,
                    }}
                  >
                    {formatGoalTooltip(stretchGoal)}
                  </Text>
                </View>
              )}
              <TouchableOpacity
                testID="marker-stretch"
                onPressIn={() => setTooltip('stretch')}
                onPressOut={() => setTooltip(null)}
                // @ts-ignore react-native-web hover props
                onMouseEnter={() => setTooltip('stretch')}
                // @ts-ignore react-native-web hover props
                onMouseLeave={() => setTooltip(null)}
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  backgroundColor: '#fffdf7',
                  borderWidth: 2,
                  borderColor: getTierColor('stretch'),
                }}
              />
            </View>
          )}
        </View>
        <View style={{ position: 'relative', marginTop: spacing(0.5, scale) }}>
          {lowGoal && lowMarker >= 0 && (
            <View
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
                zIndex: 1,
                backgroundColor: '#fffdf7',
                paddingHorizontal: 2,
                borderRadius: 2,
              }}
            >
              <Text style={{ fontSize: spacing(1.5, scale), color: getTierColor('low') }}>LG</Text>
            </View>
          )}
          {clearGoal && clearMarker >= 0 && (
            <View
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
                zIndex: 2,
                backgroundColor: '#fffdf7',
                paddingHorizontal: 2,
                borderRadius: 2,
              }}
            >
              <Text style={{ fontSize: spacing(1.5, scale), color: getTierColor('clear') }}>
                CG
              </Text>
            </View>
          )}
          {stretchGoal && stretchMarker >= 0 && hasCleared && (
            <View
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
                zIndex: 3,
                backgroundColor: '#fffdf7',
                paddingHorizontal: 2,
                borderRadius: 2,
              }}
            >
              <Text style={{ fontSize: spacing(1.5, scale), color: getTierColor('stretch') }}>
                SG
              </Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default HabitTile;
