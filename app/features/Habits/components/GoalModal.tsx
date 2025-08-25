import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  TouchableOpacity,
  Modal,
  TextInput,
  TouchableWithoutFeedback,
  ScrollView,
  Alert,
} from 'react-native';

import { STAGE_COLORS } from '../../../constants/stageColors';
import styles from '../Habits.styles';
import type { Goal, GoalModalProps, EditableGoalProps, Habit } from '../Habits.types';
import { TARGET_UNITS, FREQUENCY_UNITS, DAYS_OF_WEEK } from '../HabitsScreen';
import {
  calculateHabitProgress,
  getGoalTarget,
  getTierColor,
  getGoalTier,
  getMarkerPositions,
  getProgressPercentage,
  getProgressBarColor,
  clampPercentage,
} from '../HabitUtils';

// Constant for golden glow color to match with HabitTile
const GOLDEN_GLOW_COLOR = 'rgba(255, 215, 0, 0.6)';
const formatGoal = (g: Goal) =>
  `${g.target} ${g.target_unit} ${g.frequency_unit.replace('_', ' ')}`;

/**
 * Determine if a goal has been achieved
 * @param goal The goal to check
 * @param habit The parent habit containing the progress data
 * @returns True if goal is achieved
 */
const isGoalAchieved = (goal: Goal, habit: Habit): boolean => {
  const totalProgress = calculateHabitProgress(habit);
  const targetValue = getGoalTarget(goal);

  if (goal.is_additive) {
    return totalProgress >= targetValue;
  } else {
    return totalProgress <= targetValue;
  }
};

/**
 * Editable goal component to display and modify a habit goal
 */
const EditableGoal = ({
  goal,
  habit,
  onUpdate,
  isEditing,
}: EditableGoalProps & { habit: Habit }) => {
  const [editedGoal, setEditedGoal] = useState<Goal>({ ...goal });
  const [showTargetUnitDropdown, setShowTargetUnitDropdown] = useState(false);
  const [showFrequencyUnitDropdown, setShowFrequencyUnitDropdown] = useState(false);
  const [showDaysSelection, setShowDaysSelection] = useState(false);

  // Reset edited goal when goal or editing status changes
  useEffect(() => {
    setEditedGoal({ ...goal });
  }, [goal, isEditing]);

  const handleChange = (field: keyof Goal, value: Goal[keyof Goal]) => {
    setEditedGoal((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = () => {
    onUpdate(editedGoal);
  };

  // Check if goal is achieved
  const achieved = isGoalAchieved(goal, habit);

  const toggleDaySelection = (day: string) => {
    const currentDays = editedGoal.days_of_week || [];
    if (currentDays.includes(day)) {
      handleChange(
        'days_of_week',
        currentDays.filter((d) => d !== day),
      );
    } else {
      handleChange('days_of_week', [...currentDays, day]);
    }
  };

  return (
    <View
      style={[
        styles.goalItem,
        {
          backgroundColor: getTierColor(goal.tier),
          borderWidth: achieved ? 2 : 0,
          borderColor: achieved ? GOLDEN_GLOW_COLOR : 'transparent',
        },
      ]}
    >
      <View style={styles.goalHeader}>
        <Text style={styles.goalTier}>
          {goal.tier.toUpperCase()}
          {achieved && ' ✓'}
        </Text>
        {isEditing && (
          <TouchableOpacity onPress={handleSave} style={styles.saveButton}>
            <Text style={styles.saveButtonText}>Save</Text>
          </TouchableOpacity>
        )}
      </View>

      {isEditing ? (
        <TextInput
          style={styles.goalTitleInput}
          value={editedGoal.title}
          onChangeText={(text) => handleChange('title', text)}
          placeholder="Goal title"
        />
      ) : (
        <Text style={styles.goalTitle}>{goal.title}</Text>
      )}

      <View style={styles.goalDetailsContainer}>
        {isEditing ? (
          <>
            <View style={styles.editRow}>
              <Text style={styles.editLabel}>Target:</Text>
              <TextInput
                style={styles.editInput}
                value={editedGoal.target.toString()}
                onChangeText={(text) => handleChange('target', parseFloat(text) || 0)}
                keyboardType="numeric"
              />

              <TouchableOpacity
                style={styles.unitDropdownButton}
                onPress={() => setShowTargetUnitDropdown(!showTargetUnitDropdown)}
              >
                <Text>{editedGoal.target_unit || 'Select unit'}</Text>
              </TouchableOpacity>

              {showTargetUnitDropdown && (
                <ScrollView style={styles.dropdown} keyboardShouldPersistTaps="handled">
                  {TARGET_UNITS.map((unit) => (
                    <TouchableOpacity
                      key={unit}
                      style={styles.dropdownItem}
                      onPress={() => {
                        handleChange('target_unit', unit);
                        setShowTargetUnitDropdown(false);
                      }}
                    >
                      <Text>{unit}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>

            <View style={styles.editRow}>
              <Text style={styles.editLabel}>Frequency:</Text>
              <TextInput
                style={styles.editInput}
                value={editedGoal.frequency.toString()}
                onChangeText={(text) => handleChange('frequency', parseFloat(text) || 0)}
                keyboardType="numeric"
              />

              <TouchableOpacity
                style={styles.unitDropdownButton}
                onPress={() => setShowFrequencyUnitDropdown(!showFrequencyUnitDropdown)}
              >
                <Text>{editedGoal.frequency_unit.replace('_', ' ') || 'Select frequency'}</Text>
              </TouchableOpacity>

              {showFrequencyUnitDropdown && (
                <ScrollView style={styles.dropdown} keyboardShouldPersistTaps="handled">
                  {FREQUENCY_UNITS.map((unit) => (
                    <TouchableOpacity
                      key={unit}
                      style={styles.dropdownItem}
                      onPress={() => {
                        handleChange('frequency_unit', unit);
                        setShowFrequencyUnitDropdown(false);
                      }}
                    >
                      <Text>{unit.replace('_', ' ')}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>

            {editedGoal.frequency_unit === 'per_week' && (
              <View style={styles.editRow}>
                <Text style={styles.editLabel}>Days:</Text>
                <TouchableOpacity
                  style={styles.daysSelectorButton}
                  onPress={() => setShowDaysSelection(!showDaysSelection)}
                >
                  <Text>
                    {editedGoal.days_of_week && editedGoal.days_of_week.length > 0
                      ? editedGoal.days_of_week.map((d) => d.substring(0, 3)).join(', ')
                      : 'Select days'}
                  </Text>
                </TouchableOpacity>

                {showDaysSelection && (
                  <View style={styles.daysSelector}>
                    {DAYS_OF_WEEK.map((day) => (
                      <TouchableOpacity
                        key={day}
                        style={[
                          styles.dayOption,
                          (editedGoal.days_of_week || []).includes(day) && styles.selectedDayOption,
                        ]}
                        onPress={() => toggleDaySelection(day)}
                      >
                        <Text style={styles.dayOptionText}>{day.substring(0, 3)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}

            <View style={styles.editRow}>
              <Text style={styles.editLabel}>Type:</Text>
              <Pressable
                style={[
                  styles.toggleButton,
                  {
                    backgroundColor: editedGoal.is_additive ? '#4CAF50' : '#ccc',
                  },
                ]}
                onPress={() => handleChange('is_additive', true)}
              >
                <Text style={styles.toggleText}>Additive</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.toggleButton,
                  {
                    backgroundColor: !editedGoal.is_additive ? '#F44336' : '#ccc',
                  },
                ]}
                onPress={() => handleChange('is_additive', false)}
              >
                <Text style={styles.toggleText}>Subtractive</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Text style={styles.goalDetails}>
            {goal.is_additive ? 'At least' : 'No more than'} {goal.target} {goal.target_unit},{' '}
            {goal.frequency} {goal.frequency_unit.replace('_', ' ')}
            {goal.days_of_week &&
              goal.days_of_week.length > 0 &&
              ` on ${goal.days_of_week.map((d) => d.substring(0, 3)).join(', ')}`}
          </Text>
        )}
      </View>

      {/* Progress removed in favor of unified bar at top */}
    </View>
  );
};

/**
 * Main GoalModal component to display and manage habit goals
 */
export const GoalModal = ({ visible, habit, onClose, onUpdateGoal, onLogUnit }: GoalModalProps) => {
  const [activeGoal, setActiveGoal] = useState<Goal | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [logAmount, setLogAmount] = useState('1');
  const [goalVisible, setGoalVisible] = useState<Record<number, boolean>>({});

  // Initialize all goals to be visible initially
  useEffect(() => {
    if (habit && visible) {
      const visibilityMap: Record<number, boolean> = {};
      habit.goals.forEach((goal, index) => {
        visibilityMap[index] = true;
      });
      setGoalVisible(visibilityMap);
    }
  }, [habit, visible]);

  // Reset state when modal is closed
  useEffect(() => {
    if (!visible) {
      setIsEditing(false);
      setActiveGoal(null);
      setLogAmount('1');
    }
  }, [visible]);

  if (!habit) return null;

  const handleUpdateGoal = (updatedGoal: Goal) => {
    if (habit.id && updatedGoal.id) {
      onUpdateGoal(habit.id, updatedGoal);
      setIsEditing(false);
    }
  };

  const handleLogUnit = () => {
    if (habit.id) {
      const amount = parseFloat(logAmount) || 1;
      onLogUnit(habit.id, amount);
      setLogAmount('1');

      // Show a feedback alert
      Alert.alert(
        'Progress Logged',
        `Added ${amount} ${amount === 1 ? 'unit' : 'units'} to ${habit.name}`,
        [{ text: 'OK', onPress: () => {} }],
      );
    }
  };

  const handleEditGoal = (goal: Goal) => {
    setActiveGoal(goal);
    setIsEditing(true);
  };

  const toggleGoalVisibility = (index: number) => {
    setGoalVisible((prev) => ({
      ...prev,
      [index]: !prev[index],
    }));
  };

  // Calculate total habit progress for display
  const totalProgress = calculateHabitProgress(habit);

  const lowGoal = habit.goals.find((g) => g.tier === 'low');
  const clearGoal = habit.goals.find((g) => g.tier === 'clear');
  const stretchGoal = habit.goals.find((g) => g.tier === 'stretch');
  const { currentGoal, nextGoal } = getGoalTier(habit);
  const progressPercentage = clampPercentage(getProgressPercentage(habit, currentGoal, nextGoal));
  const {
    low: lowMarker,
    clear: clearMarker,
    stretch: stretchMarker,
  } = getMarkerPositions(lowGoal, clearGoal, stretchGoal);
  const progressBarColor = getProgressBarColor(habit);

  // Sort goals by tier for consistent display order
  const sortedGoals = [...habit.goals].sort((a, b) => {
    const tierOrder = { low: 1, clear: 2, stretch: 3 };
    return tierOrder[a.tier] - tierOrder[b.tier];
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.modalOverlay}>
          <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
            <View style={[styles.modalContent, { borderTopColor: STAGE_COLORS[habit.stage] }]}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>
                  {habit.name} <Text style={styles.iconLarge}>{habit.icon}</Text>
                </Text>
                <Text style={styles.streakBadge}>
                  {habit.streak} {habit.streak === 1 ? 'day' : 'days'}
                </Text>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Text style={styles.closeButtonText}>×</Text>
                </TouchableOpacity>
              </View>

              {/* Habit summary section */}
              <View style={styles.habitSummary}>
                <Text style={styles.habitSummaryText}>
                  Total Progress: {totalProgress} {sortedGoals[0]?.target_unit || 'units'}
                </Text>
                <Text style={styles.habitSummaryText}>
                  Energy: Cost {habit.energy_cost} · Return {habit.energy_return} · Net{' '}
                  {habit.energy_return - habit.energy_cost}
                </Text>
              </View>

              {/* Unified progress bar with markers */}
              <View style={{ marginVertical: 16 }}>
                <View
                  style={{
                    height: 12,
                    backgroundColor: '#eee',
                    borderRadius: 6,
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${progressPercentage}%`,
                      backgroundColor: progressBarColor,
                    }}
                  />
                  {lowGoal && (
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
                      onPress={() => handleEditGoal(lowGoal)}
                      onLongPress={() => Alert.alert('Low Grit', formatGoal(lowGoal))}
                    />
                  )}
                  {clearGoal && (
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
                      onPress={() => handleEditGoal(clearGoal)}
                      onLongPress={() => Alert.alert('Clear Goal', formatGoal(clearGoal))}
                    />
                  )}
                  {stretchGoal && (
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
                      onPress={() => handleEditGoal(stretchGoal)}
                      onLongPress={() => Alert.alert('Stretch Goal', formatGoal(stretchGoal))}
                    />
                  )}
                </View>
                <View style={{ position: 'relative', marginTop: 4 }}>
                  {lowGoal && (
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
                        fontSize: 10,
                        color: getTierColor('low'),
                        zIndex: 1,
                      }}
                    >
                      LG
                    </Text>
                  )}
                  {clearGoal && (
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
                        fontSize: 10,
                        color: getTierColor('clear'),
                        zIndex: 2,
                      }}
                    >
                      CG
                    </Text>
                  )}
                  {stretchGoal && (
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
                        fontSize: 10,
                        color: getTierColor('stretch'),
                        zIndex: 3,
                      }}
                    >
                      SG
                    </Text>
                  )}
                </View>
              </View>

              <ScrollView style={styles.goalsContainer}>
                {sortedGoals.map((goal, index) => (
                  <View key={index}>
                    <TouchableOpacity
                      style={styles.goalHeaderToggle}
                      onPress={() => toggleGoalVisibility(index)}
                    >
                      <Text style={styles.goalHeaderToggleText}>
                        {goal.tier.toUpperCase()} GOAL {goalVisible[index] ? '▼' : '►'}
                      </Text>
                    </TouchableOpacity>

                    {goalVisible[index] && (
                      <TouchableOpacity onPress={() => handleEditGoal(goal)}>
                        <EditableGoal
                          goal={goal}
                          habit={habit}
                          onUpdate={handleUpdateGoal}
                          isEditing={isEditing && activeGoal?.id === goal.id}
                        />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </ScrollView>

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
                <TouchableOpacity
                  style={styles.editButton}
                  onPress={() => setIsEditing(!isEditing)}
                >
                  <Text style={styles.editButtonText}>
                    {isEditing ? 'Done Editing' : 'Edit Goals'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
};

export default GoalModal;
