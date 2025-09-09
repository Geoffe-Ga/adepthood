import React, { useState, useRef, useEffect } from 'react';
import {
  Alert,
  Modal,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
  PanResponder,
} from 'react-native';
import type { LayoutChangeEvent, ViewStyle, TextStyle } from 'react-native';
import EmojiSelector from 'react-native-emoji-selector';

import { createGoal, updateGoal } from '../../../api/habits';
import { STAGE_COLORS } from '../../../constants/stageColors';
import styles from '../Habits.styles';
import type { GoalModalProps, Goal } from '../Habits.types';
import {
  getMarkerPositions,
  getProgressBarColor,
  clampPercentage,
  getTierColor,
  getGoalTarget,
  calculateHabitProgress,
} from '../HabitUtils';

const markerContainerStyle = (leftPct: number, z: number): ViewStyle => ({
  position: 'absolute',
  // @ts-ignore percentage positioning not typed
  left: `${clampPercentage(leftPct)}%`,
  top: -6,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  zIndex: z,
  alignItems: 'center',
});

const circleStyle = (color: string): ViewStyle => ({
  width: 12,
  height: 12,
  borderRadius: 6,
  backgroundColor: '#fffdf7',
  borderWidth: 2,
  borderColor: color,
});

const labelContainerStyle = (leftPct: number, z: number): ViewStyle => ({
  position: 'absolute',
  // @ts-ignore percentage positioning not typed
  left: `${clampPercentage(leftPct)}%`,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  zIndex: z,
  backgroundColor: '#fffdf7',
  paddingHorizontal: 2,
  borderRadius: 2,
});

const labelTextStyle = (color: string): TextStyle => ({ fontSize: 10, color });

const tooltipStyle = (color: string): ViewStyle => ({
  position: 'absolute',
  bottom: 16,
  backgroundColor: '#fffdf7',
  borderWidth: 1,
  borderColor: color,
  borderRadius: 4,
  paddingHorizontal: 4,
  paddingVertical: 2,
});

const tooltipTextStyle: TextStyle = {
  fontSize: 10,
  color: '#333',
  fontFamily: 'serif',
  fontStyle: 'italic',
  letterSpacing: 0.5,
};

export const GoalModal = ({
  visible,
  habit,
  onClose,
  onUpdateGoal,
  onLogUnit,
  onUpdateHabit,
}: GoalModalProps) => {
  const [logAmount, setLogAmount] = useState('1');
  const [showEmojiSelector, setShowEmojiSelector] = useState(false);
  const barWidth = useRef(0);
  const [lowMarker, setLowMarker] = useState(0);
  const [clearMarker, setClearMarker] = useState(0);
  const [tooltip, setTooltip] = useState<null | 'low' | 'clear' | 'stretch'>(null);

  const lowGoal = habit?.goals.find((g) => g.tier === 'low');
  const clearGoal = habit?.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit?.goals.find((g) => g.tier === 'stretch');
  const totalProgress = habit ? calculateHabitProgress(habit) : 0;
  const progressPercentage =
    habit && stretchGoal
      ? lowGoal?.is_additive
        ? clampPercentage((totalProgress / getGoalTarget(stretchGoal)) * 100)
        : clampPercentage(
            100 -
              ((totalProgress - getGoalTarget(stretchGoal)) /
                (getGoalTarget(lowGoal!) - getGoalTarget(stretchGoal))) *
                100,
          )
      : 0;
  const progressBarColor = habit ? getProgressBarColor(habit) : '#eee';
  const markers = getMarkerPositions(lowGoal, clearGoal, stretchGoal);
  const stretchMarker = markers.stretch;

  const formatGoalTooltip = (g: Goal | undefined) => {
    if (!g) return '';
    const label =
      g.tier === 'low' ? 'Low Grit' : g.tier === 'clear' ? 'Clear Goal' : 'Stretch Goal';
    return `${label}: ${g.target} ${g.target_unit} per ${g.frequency_unit.replace('_', ' ')}`;
  };

  useEffect(() => {
    setLowMarker(markers.low);
    setClearMarker(markers.clear);
  }, [markers.low, markers.clear]);

  const handleBarLayout = (e: LayoutChangeEvent) => {
    barWidth.current = e.nativeEvent.layout.width;
  };

  const confirmUpdate = (tier: 'low' | 'clear', percent: number) => {
    const goal = tier === 'low' ? lowGoal : clearGoal;
    if (!habit?.id) return;
    const stretchTarget = stretchGoal ? getGoalTarget(stretchGoal) : goal?.target ?? 1;
    const newTarget = Math.max(1, Math.round((percent / 100) * stretchTarget));
    Alert.alert(
      tier === 'low' ? 'Edit Low Goal' : 'Edit Clear Goal',
      `Edit the ${tier === 'low' ? 'Low Grit' : 'Clear Goal'} to be ${newTarget} ${
        (goal ?? lowGoal ?? clearGoal)?.target_unit
      } ${(goal ?? lowGoal ?? clearGoal)?.frequency_unit.replace('_', ' ')}?`,
      [
        {
          text: 'No',
          style: 'cancel',
          onPress: () => {
            if (tier === 'low') setLowMarker(markers.low);
            else setClearMarker(markers.clear);
          },
        },
        {
          text: 'Yes',
          onPress: async () => {
            try {
              if (goal && goal.id) {
                const updated = await updateGoal(habit.id!, { ...goal, target: newTarget });
                onUpdateGoal(habit.id!, updated);
              } else {
                const base = {
                  title: tier,
                  tier,
                  target: newTarget,
                  target_unit: lowGoal?.target_unit || clearGoal?.target_unit || 'units',
                  frequency: lowGoal?.frequency || clearGoal?.frequency || 1,
                  frequency_unit: lowGoal?.frequency_unit || clearGoal?.frequency_unit || 'per_day',
                  is_additive: lowGoal?.is_additive ?? clearGoal?.is_additive ?? true,
                };
                const created = await createGoal(habit.id!, base);
                onUpdateGoal(habit.id!, created);
              }
            } catch (error) {
              console.error(error);
            }
          },
        },
      ],
    );
  };

  const createPanResponder = (tier: 'low' | 'clear') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setTooltip(tier),
      onPanResponderMove: (_, gesture) => {
        const init = tier === 'low' ? markers.low : markers.clear;
        const percent = (((init / 100) * barWidth.current + gesture.dx) / barWidth.current) * 100;
        if (tier === 'low') {
          setLowMarker(Math.min(clampPercentage(percent), clearMarker - 5));
        } else {
          setClearMarker(Math.max(clampPercentage(percent), lowMarker + 5));
        }
      },
      onPanResponderRelease: () => {
        const percent = tier === 'low' ? lowMarker : clearMarker;
        setTooltip(null);
        confirmUpdate(tier, percent);
      },
      onPanResponderTerminate: () => setTooltip(null),
    });

  const lowPan = useRef(createPanResponder('low')).current;
  const clearPan = useRef(createPanResponder('clear')).current;

  const handleLogUnit = () => {
    if (habit?.id) {
      const amount = parseFloat(logAmount) || 1;
      onLogUnit(habit.id, amount);
      setLogAmount('1');
    }
  };

  if (!habit) return null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.modalOverlay}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <View style={[styles.modalContent, { borderTopColor: STAGE_COLORS[habit.stage] }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{habit.name}</Text>
                <TouchableOpacity onPress={() => setShowEmojiSelector(true)}>
                  <Text style={styles.iconLarge}>{habit.icon}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Text style={styles.closeButtonText}>×</Text>
                </TouchableOpacity>
              </View>

              {showEmojiSelector && (
                <View style={styles.emojiSelectorContainer}>
                  <EmojiSelector
                    onEmojiSelected={(emoji) => {
                      onUpdateHabit({ ...habit, icon: emoji });
                      setShowEmojiSelector(false);
                    }}
                    showSearchBar
                    columns={6}
                    // @ts-ignore react-native-emoji-selector missing emojiSize typing
                    emojiSize={28}
                  />
                </View>
              )}

              <View style={{ marginVertical: 16 }} onLayout={handleBarLayout}>
                <View style={{ height: 12, position: 'relative' }}>
                  <View
                    style={{
                      height: '100%',
                      backgroundColor: '#eee',
                      borderRadius: 6,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      testID="modal-progress-fill"
                      style={{
                        height: '100%',
                        width: `${progressPercentage}%`,
                        backgroundColor: progressBarColor,
                        borderRadius: 6,
                      }}
                    />
                  </View>
                  {lowGoal && (
                    <View
                      testID="modal-marker-low"
                      {...lowPan.panHandlers}
                      // @ts-ignore react-native-web hover props
                      onMouseEnter={() => setTooltip('low')}
                      // @ts-ignore react-native-web hover props
                      onMouseLeave={() => setTooltip(null)}
                      style={markerContainerStyle(lowMarker, 1)}
                    >
                      {tooltip === 'low' && (
                        <View testID="modal-tooltip-low" style={tooltipStyle(getTierColor('low'))}>
                          <Text style={tooltipTextStyle}>{formatGoalTooltip(lowGoal)}</Text>
                        </View>
                      )}
                      <View style={circleStyle(getTierColor('low'))} />
                    </View>
                  )}
                  {clearGoal && (
                    <View
                      testID="modal-marker-clear"
                      {...clearPan.panHandlers}
                      // @ts-ignore react-native-web hover props
                      onMouseEnter={() => setTooltip('clear')}
                      // @ts-ignore react-native-web hover props
                      onMouseLeave={() => setTooltip(null)}
                      style={markerContainerStyle(clearMarker, 2)}
                    >
                      {tooltip === 'clear' && (
                        <View
                          testID="modal-tooltip-clear"
                          style={tooltipStyle(getTierColor('clear'))}
                        >
                          <Text style={tooltipTextStyle}>{formatGoalTooltip(clearGoal)}</Text>
                        </View>
                      )}
                      <View style={circleStyle(getTierColor('clear'))} />
                    </View>
                  )}
                  {stretchGoal && (
                    <TouchableOpacity
                      testID="modal-marker-stretch"
                      onPressIn={() => setTooltip('stretch')}
                      onPressOut={() => setTooltip(null)}
                      // @ts-ignore hover props
                      onMouseEnter={() => setTooltip('stretch')}
                      // @ts-ignore hover props
                      onMouseLeave={() => setTooltip(null)}
                      style={markerContainerStyle(stretchMarker, 3)}
                    >
                      {tooltip === 'stretch' && (
                        <View
                          testID="modal-tooltip-stretch"
                          style={tooltipStyle(getTierColor('stretch'))}
                        >
                          <Text style={tooltipTextStyle}>{formatGoalTooltip(stretchGoal)}</Text>
                        </View>
                      )}
                      <View style={circleStyle(getTierColor('stretch'))} />
                    </TouchableOpacity>
                  )}
                </View>
                <View style={{ position: 'relative', marginTop: 4 }}>
                  {lowGoal && (
                    <View style={labelContainerStyle(lowMarker, 1)}>
                      <Text style={labelTextStyle(getTierColor('low'))}>LG</Text>
                    </View>
                  )}
                  {clearGoal && (
                    <View style={labelContainerStyle(clearMarker, 2)}>
                      <Text style={labelTextStyle(getTierColor('clear'))}>CG</Text>
                    </View>
                  )}
                  {stretchGoal && (
                    <View style={labelContainerStyle(stretchMarker, 3)}>
                      <Text style={labelTextStyle(getTierColor('stretch'))}>SG</Text>
                    </View>
                  )}
                </View>
              </View>

              <View style={styles.actionButtons}>
                <View style={styles.logUnitContainer}>
                  <TextInput
                    style={styles.logUnitInput}
                    value={logAmount}
                    onChangeText={setLogAmount}
                    keyboardType="numeric"
                  />
                  <TouchableOpacity style={styles.logUnitButton} onPress={handleLogUnit}>
                    <Text style={styles.logUnitButtonText}>Log Units</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

export default GoalModal;
