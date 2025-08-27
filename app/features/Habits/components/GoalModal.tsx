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

import { STAGE_COLORS } from '../../../constants/stageColors';
import styles from '../Habits.styles';
import type { GoalModalProps } from '../Habits.types';
import {
  getMarkerPositions,
  getProgressBarColor,
  clampPercentage,
  getTierColor,
  getGoalTarget,
  calculateHabitProgress,
} from '../HabitUtils';

const bubbleStyle = (color: string, leftPct: number): ViewStyle => ({
  position: 'absolute',
  // @ts-ignore percentage positioning not typed
  left: `${clampPercentage(leftPct)}%`,
  top: -6,
  width: 12,
  height: 12,
  borderRadius: 6,
  backgroundColor: '#fffdf7',
  borderWidth: 2,
  borderColor: color,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
});

const labelStyle = (color: string, leftPct: number): TextStyle => ({
  position: 'absolute',
  // @ts-ignore percentage positioning not typed
  left: `${clampPercentage(leftPct)}%`,
  transform: [
    {
      translateX: clampPercentage(leftPct) === 0 ? 0 : clampPercentage(leftPct) === 100 ? -12 : -6,
    },
  ],
  fontSize: 10,
  color,
});

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

  useEffect(() => {
    setLowMarker(markers.low);
    setClearMarker(markers.clear);
  }, [markers.low, markers.clear]);

  const handleBarLayout = (e: LayoutChangeEvent) => {
    barWidth.current = e.nativeEvent.layout.width;
  };

  const confirmUpdate = (tier: 'low' | 'clear', percent: number) => {
    const goal = tier === 'low' ? lowGoal : clearGoal;
    if (!goal || !habit?.id) return;
    const stretchTarget = stretchGoal ? getGoalTarget(stretchGoal) : goal.target;
    const newTarget = Math.max(1, Math.round((percent / 100) * stretchTarget));
    Alert.alert(
      tier === 'low' ? 'Edit Low Goal' : 'Edit Clear Goal',
      `Edit the ${tier === 'low' ? 'Low Grit' : 'Clear Goal'} to be ${newTarget} ${goal.target_unit} ${goal.frequency_unit.replace(
        '_',
        ' ',
      )}?`,
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
          onPress: () => onUpdateGoal(habit.id!, { ...goal, target: newTarget }),
        },
      ],
    );
  };

  const createPanResponder = (tier: 'low' | 'clear') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
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
        confirmUpdate(tier, percent);
      },
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
                      style={bubbleStyle(getTierColor('low'), lowMarker)}
                    />
                  )}
                  {clearGoal && (
                    <View
                      testID="modal-marker-clear"
                      {...clearPan.panHandlers}
                      style={bubbleStyle(getTierColor('clear'), clearMarker)}
                    />
                  )}
                  {stretchGoal && (
                    <View
                      testID="modal-marker-stretch"
                      style={bubbleStyle(getTierColor('stretch'), stretchMarker)}
                    />
                  )}
                </View>
                <View style={{ position: 'relative', marginTop: 4 }}>
                  {lowGoal && <Text style={labelStyle(getTierColor('low'), lowMarker)}>LG</Text>}
                  {clearGoal && (
                    <Text style={labelStyle(getTierColor('clear'), clearMarker)}>CG</Text>
                  )}
                  {stretchGoal && (
                    <Text style={labelStyle(getTierColor('stretch'), stretchMarker)}>SG</Text>
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
