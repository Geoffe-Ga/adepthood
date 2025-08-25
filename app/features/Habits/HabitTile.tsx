import { MoreHorizontal, Edit, CheckCircle, BarChart } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Text, TouchableOpacity, View } from 'react-native';

import { STAGE_COLORS } from '../../constants/stageColors';
import { spacing } from '../../Sources/design/DesignSystem';
import useResponsive from '../../Sources/design/useResponsive';

import styles from './Habits.styles';
import type { Goal, HabitTileProps } from './Habits.types';
import {
  calculateProgressPercentage,
  getGoalTier,
  getProgressBarColor,
  getTierColor,
  getMarkerPositions,
  clampPercentage,
} from './HabitUtils';

// Constants
const TOOLTIP_DISPLAY_TIME = 2000; // 2 seconds to display tooltip

export const HabitTile = ({
  habit,
  onOpenGoals,
  onLogUnit,
  onOpenStats,
  onLongPress,
}: HabitTileProps) => {
  const { scale } = useResponsive();
  const backgroundColor = '#f8f8f8'; // Neutral background for all habits
  const stageColor = STAGE_COLORS[habit.stage];
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const [showMarkerTooltip, setShowMarkerTooltip] = useState<Goal['tier'] | null>(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [goalAchievedMessage, setGoalAchievedMessage] = useState('');
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const isMobile = Platform.OS === 'ios' || Platform.OS === 'android';

  const lowGoal = habit.goals.find((g) => g.tier === 'low');
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');

  const { currentGoal, nextGoal, completedAllGoals } = getGoalTier(habit);
  const progressPercentage = clampPercentage(
    calculateProgressPercentage(habit, currentGoal, nextGoal),
  );
  const progressBarColor = getProgressBarColor(habit);
  const progressBarWidth = progressPercentage / 100;
  const hasCompletedGoal = completedAllGoals || progressPercentage >= 100;

  // Show flash message when a clear goal is achieved
  useEffect(() => {
    if (goalAchievedMessage) {
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.delay(2000),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setGoalAchievedMessage('');
      });
    }
  }, [goalAchievedMessage, fadeAnim]);

  // Animation functions
  const animateIn = () => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      friction: 5,
      tension: 100,
      useNativeDriver: true,
    }).start();
  };

  const animateOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 5,
      tension: 100,
      useNativeDriver: true,
    }).start();
  };

  // Handlers
  const handlePressIn = () => {
    if (!habit.revealed) return;
    animateIn();
  };

  const handlePressOut = () => {
    if (!habit.revealed) return;
    animateOut();
  };

  const handlePress = () => {
    if (!habit.revealed) return;
    onOpenGoals();
  };

  const {
    low: lowMarkerPosition,
    clear: clearMarkerPosition,
    stretch: stretchMarkerPosition,
  } = getMarkerPositions(lowGoal, clearGoal, stretchGoal);

  // Show action menu (for mobile)
  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  // Show marker tooltip on hover/press
  const showMarkerInfo = (tier: Goal['tier']) => {
    setShowMarkerTooltip(tier);

    // Auto-hide tooltip after a delay
    setTimeout(() => {
      setShowMarkerTooltip(null);
    }, TOOLTIP_DISPLAY_TIME);
  };

  // Format the marker tooltip text
  const getMarkerTooltipText = (tier: Goal['tier']) => {
    const goal = tier === 'low' ? lowGoal : tier === 'clear' ? clearGoal : stretchGoal;

    if (!goal) return '';

    // Create descriptive tooltip
    return `${tier.charAt(0).toUpperCase() + tier.slice(1)} Goal: ${goal.target} ${goal.target_unit} ${goal.frequency_unit}`;
  };

  return (
    <Animated.View
      testID="habit-tile"
      style={[
        styles.tile,
        {
          backgroundColor,
          opacity: habit.revealed ? 1 : 0.5,
          transform: [{ scale: scaleAnim }],
          borderWidth: hasCompletedGoal ? 2 : 1,
          borderColor: stageColor,
          margin: spacing(0.5, scale),
          padding: spacing(2, scale),
          minHeight: spacing(8, scale),
        },
      ]}
    >
      {/* Achievement Flash Message */}
      {goalAchievedMessage && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            backgroundColor: stageColor,
            padding: 8,
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
            opacity: fadeAnim,
            zIndex: 10,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontWeight: 'bold', color: '#333' }}>{goalAchievedMessage}</Text>
        </Animated.View>
      )}

      {/* Mobile Menu */}
      {isMobile && (
        <TouchableOpacity
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 5,
          }}
          onPress={toggleMenu}
        >
          <MoreHorizontal size={22} color="#333" />
        </TouchableOpacity>
      )}

      {/* Mobile Menu Popup */}
      {isMobile && isMenuOpen && (
        <View
          style={{
            position: 'absolute',
            top: 36,
            right: 8,
            backgroundColor: 'white',
            borderRadius: 8,
            padding: 8,
            zIndex: 10,
            ...styles.menuShadow,
            borderWidth: 1,
            borderColor: '#eee',
          }}
        >
          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', padding: 8 }}
            onPress={() => {
              onOpenStats();
              setIsMenuOpen(false);
            }}
          >
            <BarChart size={18} color="#333" style={{ marginRight: 8 }} />
            <Text>Stats</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', padding: 8 }}
            onPress={() => {
              onLongPress();
              setIsMenuOpen(false);
            }}
          >
            <Edit size={18} color="#333" style={{ marginRight: 8 }} />
            <Text>Edit</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={{ flexDirection: 'row', alignItems: 'center', padding: 8 }}
            onPress={() => {
              onLogUnit();
              setIsMenuOpen(false);
            }}
          >
            <CheckCircle size={18} color="#333" style={{ marginRight: 8 }} />
            <Text>Log</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Desktop Action Icons */}
      {!isMobile && (
        <View
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            flexDirection: 'row',
            zIndex: 5,
          }}
        >
          <TouchableOpacity style={{ padding: 6 }} onPress={onOpenStats}>
            <BarChart size={18} color="#333" />
          </TouchableOpacity>

          <TouchableOpacity style={{ padding: 6 }} onPress={onLongPress}>
            <Edit size={18} color="#333" />
          </TouchableOpacity>

          <TouchableOpacity style={{ padding: 6 }} onPress={onLogUnit}>
            <CheckCircle size={18} color="#333" />
          </TouchableOpacity>
        </View>
      )}

      {/* Main tile content */}
      <TouchableOpacity
        onPress={handlePress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={{ width: '100%', alignItems: 'center' }}
      >
        <Text style={[styles.icon, { fontSize: 32 * scale }]}>{habit.icon}</Text>
        <Text
          style={[styles.name, { color: habit.revealed ? '#333' : '#aaa', fontSize: 16 * scale }]}
        >
          {habit.name}
        </Text>

        {habit.revealed && (
          <View style={styles.streakContainer}>
            <Text style={styles.streakText}>
              {habit.streak} {habit.streak === 1 ? 'day' : 'days'}
            </Text>
          </View>
        )}

        {/* Progress Bar */}
        {habit.revealed && lowGoal && (
          <View style={[styles.progressBarContainer, { marginTop: spacing(1.5, scale) }]}>
            <View
              style={[styles.progressBar, { height: Math.max(8, 10 * scale), overflow: 'visible' }]}
            >
              {/* Goal markers with improved visibility and correct positioning */}
              {lowGoal && lowMarkerPosition >= 0 && (
                <TouchableOpacity
                  style={[
                    styles.goalMarker,
                    {
                      left: `${clampPercentage(lowMarkerPosition)}%`,
                      height: Math.max(16, spacing(2, scale)),
                      width: 4,
                      top: -2,
                      backgroundColor: getTierColor('low'),
                      borderRadius: 2,
                    },
                  ]}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  onPress={() => showMarkerInfo('low')}
                />
              )}

              {clearGoal && clearMarkerPosition >= 0 && (
                <TouchableOpacity
                  style={[
                    styles.goalMarker,
                    {
                      left: `${clampPercentage(clearMarkerPosition)}%`,
                      height: Math.max(16, spacing(2, scale)),
                      width: 4,
                      top: -2,
                      backgroundColor: getTierColor('clear'),
                      borderRadius: 2,
                    },
                  ]}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  onPress={() => showMarkerInfo('clear')}
                />
              )}

              {stretchGoal && stretchMarkerPosition >= 0 && (
                <TouchableOpacity
                  style={[
                    styles.goalMarker,
                    {
                      left: `${clampPercentage(stretchMarkerPosition)}%`,
                      height: Math.max(16, spacing(2, scale)),
                      width: 4,
                      top: -2,
                      backgroundColor: getTierColor('stretch'),
                      borderRadius: 2,
                    },
                  ]}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  onPress={() => showMarkerInfo('stretch')}
                />
              )}

              {/* Enhanced marker tooltips */}
              {showMarkerTooltip && (
                <View
                  style={{
                    position: 'absolute',
                    top: -40,
                    left:
                      showMarkerTooltip === 'low'
                        ? `${clampPercentage(lowMarkerPosition)}%`
                        : showMarkerTooltip === 'clear'
                          ? `${clampPercentage(clearMarkerPosition)}%`
                          : `${clampPercentage(stretchMarkerPosition)}%`,
                    transform: [
                      {
                        translateX:
                          (showMarkerTooltip === 'low'
                            ? lowMarkerPosition
                            : showMarkerTooltip === 'clear'
                              ? clearMarkerPosition
                              : stretchMarkerPosition) < 10
                            ? 0
                            : (showMarkerTooltip === 'low'
                                  ? lowMarkerPosition
                                  : showMarkerTooltip === 'clear'
                                    ? clearMarkerPosition
                                    : stretchMarkerPosition) > 90
                              ? -100
                              : -50,
                      },
                    ],
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    padding: 8,
                    borderRadius: 4,
                    zIndex: 10,
                    minWidth: 120,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: 'white', fontSize: 12 }}>
                    {getMarkerTooltipText(showMarkerTooltip)}
                  </Text>
                </View>
              )}

              {/* Progress fill */}
              <View
                testID="progress-fill"
                style={[
                  styles.progressBarFill,
                  {
                    width: `${progressBarWidth * 100}%`,
                    backgroundColor: progressBarColor,
                    height: '100%',
                  },
                ]}
              />
            </View>
          </View>
        )}

        {/* Achievement indicator */}
        {hasCompletedGoal ? (
          <View
            style={{
              marginTop: 3,
              marginBottom: 10,
              borderRadius: 4,
              paddingHorizontal: 6,
              paddingVertical: 2,
              backgroundColor: progressBarColor,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: 'bold',
                color: '#ffffff',
                textShadowColor: '#000',
                textShadowOffset: { width: 1, height: 1 },
                textShadowRadius: 2,
              }}
            >
              Goal Achieved!
            </Text>
          </View>
        ) : (
          <View
            style={{
              paddingVertical: spacing(1, scale),
            }}
          ></View>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
};

export default HabitTile;
