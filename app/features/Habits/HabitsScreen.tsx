// HabitsScreen.tsx

import * as Notifications from 'expo-notifications';
import { BarChart2, Check, MoreHorizontal, Pencil, Zap } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Text, TouchableOpacity, View, Modal } from 'react-native';
import EmojiSelector from 'react-native-emoji-selector';
import { SafeAreaView } from 'react-native-safe-area-context';

import { spacing } from '../../Sources/design/DesignSystem';
import useResponsive from '../../Sources/design/useResponsive';

import GoalModal from './components/GoalModal';
import HabitSettingsModal from './components/HabitSettingsModal';
import MissedDaysModal from './components/MissedDaysModal';
import OnboardingModal from './components/OnboardingModal';
import ReorderHabitsModal from './components/ReorderHabitsModal';
import StatsModal from './components/StatsModal';
import { HABIT_DEFAULTS } from './HabitDefaults';
import styles from './Habits.styles';
import type { Goal, Habit, HabitStatsData, OnboardingHabit } from './Habits.types';
import HabitTile from './HabitTile';
import { getGoalTier, getGoalTarget, calculateHabitProgress, logHabitUnits } from './HabitUtils';
export const DEFAULT_ICONS = [
  '🧘',
  '🏃',
  '💧',
  '🥗',
  '💪',
  '📱',
  '🍷',
  '☕',
  '🎨',
  '💼',
  '🧠',
  '🌱',
  '🌞',
  '🌙',
  '📚',
  '✍️',
  '🤔',
  '🗣️',
  '👥',
  '❤️',
];

export const TARGET_UNITS = [
  'minutes',
  'hours',
  'reps',
  'sets',
  'cups',
  'liters',
  'ml',
  'oz',
  'pages',
  'sessions',
  'steps',
  'calories',
  'times',
  'units',
  'mg',
  'g',
  'kg',
  'lbs',
  'points',
  'days',
];

export const FREQUENCY_UNITS = ['per_day', 'per_week', 'per_month', 'per_session'];

export const DAYS_OF_WEEK = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

// Sample default habits – these might be loaded or saved to AsyncStorage
const DEFAULT_HABITS: Habit[] = HABIT_DEFAULTS.map((habit) => ({
  ...habit,
  revealed: true,
  completions: [], // Initialize empty completions array
}));

// Register for push notifications
const registerForPushNotificationsAsync = async (): Promise<string | undefined> => {
  try {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      return undefined;
    }
    const token = (await Notifications.getExpoPushTokenAsync()).data;
    return token;
  } catch (error) {
    console.error('Failed to get push token:', error);
    return undefined;
  }
};

// Schedule a notification for a habit using its defined time and frequency
const scheduleHabitNotification = async (
  habit: Habit,
  notificationTime: string,
): Promise<string[]> => {
  // Ensure we always pass numeric values to the notification trigger
  const [hours = 0, minutes = 0] = notificationTime.split(':').map(Number);

  const schedule = async (trigger: Notifications.NotificationTriggerInput): Promise<string> => {
    return Notifications.scheduleNotificationAsync({
      content: {
        title: `Time for: ${habit.name}`,
        body: `Continue your ${habit.streak}-day streak! 💪`,
        data: { habitId: habit.id },
      },
      trigger,
    });
  };

  if (habit.notificationFrequency === 'daily') {
    const dailyTrigger: Notifications.DailyTriggerInput = {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: hours,
      minute: minutes,
    };

    return [await schedule(dailyTrigger)];
  }

  if (habit.notificationFrequency === 'weekly') {
    const weeklyTrigger: Notifications.WeeklyTriggerInput = {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: 1,
      hour: hours,
      minute: minutes,
    };

    return [await schedule(weeklyTrigger)];
  }

  if (
    habit.notificationFrequency === 'custom' &&
    habit.notificationDays &&
    habit.notificationDays.length > 0
  ) {
    // For the custom frequency, we'll schedule multiple notifications
    const notificationIds: string[] = [];

    for (const day of habit.notificationDays) {
      const weekday = DAYS_OF_WEEK.indexOf(day) + 1; // 1-7, where 1 is Monday
      const customTrigger: Notifications.WeeklyTriggerInput = {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday,
        hour: hours,
        minute: minutes,
      };

      const id = await schedule(customTrigger);
      notificationIds.push(id);
    }

    return notificationIds;
  }

  const fallbackTrigger: Notifications.DailyTriggerInput = {
    type: Notifications.SchedulableTriggerInputTypes.DAILY,
    hour: hours,
    minute: minutes,
  };

  return [await schedule(fallbackTrigger)];
};

// Update notifications for a habit (cancel old ones and schedule new)
const updateHabitNotifications = async (habit: Habit): Promise<string[]> => {
  if (!habit.id) return [];
  if (habit.notificationIds && habit.notificationIds.length > 0) {
    await Promise.all(
      habit.notificationIds.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
    );
  }

  if (
    habit.notificationFrequency === 'off' ||
    !habit.notificationTimes ||
    habit.notificationTimes.length === 0
  ) {
    return [];
  }

  const notificationIds: string[] = [];

  for (const notificationTime of habit.notificationTimes) {
    const ids = await scheduleHabitNotification(habit, notificationTime);
    notificationIds.push(...ids);
  }

  return notificationIds;
};

// Calculate net energy for a habit
export const calculateNetEnergy = (cost: number, returnValue: number): number => {
  return returnValue - cost;
};

// Calculate progress increments for a goal based on its target

//------------------
// Main Habits Screen Component
//------------------

const HabitsScreen = () => {
  const [habits, setHabits] = useState<Habit[]>(DEFAULT_HABITS);
  const [selectedHabit, setSelectedHabit] = useState<Habit | null>(null);
  const [menuVisible, setMenuVisible] = useState(false);
  const [goalModalVisible, setGoalModalVisible] = useState(false);
  const [statsModalVisible, setStatsModalVisible] = useState(false);
  const [statsMode, setStatsMode] = useState(false);
  const [quickLogMode, setQuickLogMode] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [reorderModalVisible, setReorderModalVisible] = useState(false);
  const [missedDaysModalVisible, setMissedDaysModalVisible] = useState(false);
  const [onboardingVisible, setOnboardingVisible] = useState(habits.length === 0);
  const [showEnergyCTA, setShowEnergyCTA] = useState(true);
  const [showArchiveMessage, setShowArchiveMessage] = useState(false);
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [emojiHabitIndex, setEmojiHabitIndex] = useState<number | null>(null);

  // Register for push notifications on mount
  useEffect(() => {
    void registerForPushNotificationsAsync();
  }, []);

  // Handle goal updates
  const handleUpdateGoal = (habitId: number, updatedGoal: Goal) => {
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== habitId) return h;
        const goals = h.goals.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal));
        const low = goals.find((g) => g.tier === 'low');
        const clear = goals.find((g) => g.tier === 'clear');
        const stretch = goals.find((g) => g.tier === 'stretch');
        if (low && clear && stretch) {
          // Enforce consistent units/frequency
          const unit = updatedGoal.target_unit;
          const freq = updatedGoal.frequency;
          const freqUnit = updatedGoal.frequency_unit;
          goals.forEach((g) => {
            g.target_unit = unit;
            g.frequency = freq;
            g.frequency_unit = freqUnit;
          });

          if (low.is_additive) {
            if (low.target > clear.target) clear.target = low.target;
            if (clear.target > stretch.target) stretch.target = clear.target;
          } else {
            if (clear.target < stretch.target) clear.target = stretch.target;
            if (low.target < clear.target) low.target = clear.target;
          }
        }
        return { ...h, goals };
      }),
    );
  };

  // Log progress units for a habit
  const handleLogUnit = (habitId: number, amount: number) => {
    let updated: Habit | null = null;
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id !== habitId) return h;
        const oldProgress = calculateHabitProgress(h);
        const updatedHabit = logHabitUnits(h, amount);
        const newProgress = calculateHabitProgress(updatedHabit);
        const { currentGoal, nextGoal } = getGoalTier(updatedHabit);
        updated = updatedHabit;

        if (currentGoal.is_additive) {
          const currentTarget = getGoalTarget(currentGoal);
          if (
            oldProgress < currentTarget &&
            newProgress >= currentTarget &&
            currentGoal.tier === 'low'
          ) {
            Alert.alert(
              'Goal Achieved!',
              `You've reached your Low Goal for ${h.name}! Keep going for the Clear Goal.`,
            );
          }
          if (
            nextGoal &&
            currentGoal.tier === 'clear' &&
            oldProgress < getGoalTarget(currentGoal) &&
            newProgress >= getGoalTarget(currentGoal)
          ) {
            Alert.alert('Achieved! Keep going for the Stretch Goal!');
          }
          if (
            nextGoal &&
            currentGoal.tier === 'stretch' &&
            oldProgress < getGoalTarget(currentGoal) &&
            newProgress >= getGoalTarget(currentGoal)
          ) {
            Alert.alert(
              'Stretch Goal Achieved!',
              `Amazing! You've reached your Stretch Goal for ${h.name}!`,
            );
          }
        }

        return updatedHabit;
      }),
    );
    if (selectedHabit?.id === habitId && updated) {
      setSelectedHabit(updated);
    }
  };

  // Update habit details
  const handleUpdateHabit = (updatedHabit: Habit) => {
    setHabits((prev) => prev.map((h) => (h.id === updatedHabit.id ? updatedHabit : h)));
    void updateHabitNotifications(updatedHabit);
  };

  // Delete a habit
  const handleDeleteHabit = (habitId: number) => {
    setHabits((prev) => prev.filter((h) => h.id !== habitId));
  };

  // Save the order of habits
  const handleSaveHabitOrder = (orderedHabits: Habit[]) => {
    setHabits(orderedHabits);
  };

  // Open reorder modal
  const handleOpenReorderModal = () => {
    setSettingsModalVisible(false);
    setReorderModalVisible(true);
  };

  // Generate stats data based on completions (in a real app, this would use actual data)
  const generateStatsForHabit = (habit: Habit): HabitStatsData => {
    // For demonstration purposes - in a real app, calculate based on habit.completions
    return {
      dates: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      values: [1, 2, 3, 2, 4, 1, 0],
      completionsByDay: [1, 1, 1, 1, 1, 0, 0],
      dayLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      longestStreak: habit.streak || 5,
      totalCompletions: habit.completions?.length || 12,
      completionRate: 0.75,
    };
  };

  // Handle backfilling missed days
  const handleBackfillMissedDays = (habitId: number, days: Date[]) => {
    setHabits((prev) =>
      prev.map((habit) => {
        if (habit.id === habitId) {
          // Create completion entries for each missed day
          const newCompletions = days.map((day) => ({
            id: Math.random(), // Generate a unique ID in a real app
            timestamp: day,
            completed_units: 1, // Default to 1 unit per missed day
          }));

          const updatedCompletions = habit.completions
            ? [...habit.completions, ...newCompletions]
            : newCompletions;

          return {
            ...habit,
            streak: habit.streak + days.length,
            last_completion_date: new Date(),
            completions: updatedCompletions,
          };
        }
        return habit;
      }),
    );
  };

  // Reset habit to a new start date
  const handleSetNewStartDate = (habitId: number, newDate: Date) => {
    setHabits((prev) =>
      prev.map((habit) => {
        if (habit.id === habitId) {
          return {
            ...habit,
            start_date: newDate,
            streak: 0,
            last_completion_date: undefined,
            completions: [], // Reset completions
          };
        }
        return habit;
      }),
    );
  };

  // Handle onboarding completion
  const handleOnboardingSave = (newHabits: OnboardingHabit[]) => {
    // Convert onboarding habits to full habits with IDs and goals
    const fullHabits = newHabits.map((habit, index) => ({
      ...habit,
      id: index + 1,
      streak: 0,
      revealed: habit.stage === 'Beige', // Only reveal Beige stage habits initially
      completions: [], // Initialize empty completions array
      goals: [
        {
          id: index * 3 + 1,
          title: `Low goal for ${habit.name}`,
          tier: 'low' as 'low',
          target: 1,
          target_unit: 'units',
          frequency: 1,
          frequency_unit: 'per_day',
          is_additive: true,
        },
        {
          id: index * 3 + 2,
          title: `Clear goal for ${habit.name}`,
          tier: 'clear' as 'clear',
          target: 2,
          target_unit: 'units',
          frequency: 1,
          frequency_unit: 'per_day',
          is_additive: true,
        },
        {
          id: index * 3 + 3,
          title: `Stretch goal for ${habit.name}`,
          tier: 'stretch' as 'stretch',
          target: 3,
          target_unit: 'units',
          frequency: 1,
          frequency_unit: 'per_day',
          is_additive: true,
        },
      ],
    }));

    setHabits(fullHabits);
  };

  // Render a habit tile
  const { columns, gridGutter, scale, isLG, isXL } = useResponsive();
  const screenPadding = spacing(isLG || isXL ? 2 : 1, scale);

  const handleIconPress = (index: number) => {
    setEmojiHabitIndex(index);
    setEmojiPickerVisible(true);
  };

  const handleEmojiSelect = (emoji: string) => {
    if (emojiHabitIndex !== null) {
      setHabits((prev) => prev.map((h, i) => (i === emojiHabitIndex ? { ...h, icon: emoji } : h)));
      setEmojiPickerVisible(false);
      setEmojiHabitIndex(null);
    }
  };

  const renderHabitTile = ({ item, index }: { item: Habit; index: number }) => (
    <HabitTile
      habit={item}
      onOpenGoals={() => {
        setSelectedHabit(item);
        if (statsMode) {
          setStatsModalVisible(true);
        } else if (editMode) {
          setSettingsModalVisible(true);
        } else if (quickLogMode) {
          handleLogUnit(item.id!, 1);
        } else {
          setGoalModalVisible(true);
        }
      }}
      onLongPress={() => {
        setSelectedHabit(item);
        setSettingsModalVisible(true);
      }}
      onIconPress={() => handleIconPress(index)}
    />
  );

  return (
    <SafeAreaView style={[styles.container, { padding: screenPadding }]}>
      <View style={styles.topBar}>
        <View style={styles.overflowMenuContainer} testID="overflow-menu-wrapper">
          <TouchableOpacity
            testID="overflow-menu-toggle"
            onPress={() => setMenuVisible((v) => !v)}
            style={{ padding: spacing(1, scale) }}
          >
            <MoreHorizontal size={spacing(3, scale)} />
          </TouchableOpacity>
          {menuVisible && (
            <View
              testID="overflow-menu"
              style={[styles.mobileMenu, { top: spacing(4, scale), right: 0 }]}
            >
              <TouchableOpacity
                onPress={() => {
                  setQuickLogMode(true);
                  setStatsMode(false);
                  setEditMode(false);
                  setMenuVisible(false);
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Check size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Quick Log</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setStatsMode(true);
                  setQuickLogMode(false);
                  setEditMode(false);
                  setMenuVisible(false);
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <BarChart2 size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Stats</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setEditMode(true);
                  setQuickLogMode(false);
                  setStatsMode(false);
                  setMenuVisible(false);
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Pencil size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Edit</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setOnboardingVisible(true);
                  setMenuVisible(false);
                }}
                style={{ paddingVertical: spacing(0.5, scale) }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Zap size={spacing(2, scale)} style={{ marginRight: spacing(1, scale) }} />
                  <Text>Energy Scaffolding</Text>
                </View>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      <FlatList
        key={`cols-${columns}`}
        testID="habits-list"
        data={habits.filter((h) => h.revealed)}
        keyExtractor={(item) => item.id?.toString() ?? item.name}
        renderItem={renderHabitTile}
        numColumns={columns}
        columnWrapperStyle={columns > 1 ? { gap: gridGutter } : undefined}
        contentContainerStyle={[
          styles.habitsGrid,
          {
            padding: gridGutter / 2,
            paddingBottom: gridGutter / 2,
          },
        ]}
      />

      {showEnergyCTA && !(statsMode || editMode || quickLogMode) ? (
        <View style={styles.energyScaffoldingContainer}>
          <TouchableOpacity
            style={styles.energyScaffoldingButton}
            onPress={() => setOnboardingVisible(true)}
          >
            <Text style={styles.energyScaffoldingButtonText}>Perform Energy Scaffolding</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="archive-energy-cta"
            onPress={() => {
              setShowEnergyCTA(false);
              setShowArchiveMessage(true);
              setTimeout(() => setShowArchiveMessage(false), 3000);
            }}
            style={styles.archiveEnergyButton}
          >
            <Text>Archive This</Text>
          </TouchableOpacity>
        </View>
      ) : showArchiveMessage ? (
        <Text style={styles.archivedMessage}>Energy Scaffolding button moved to menu.</Text>
      ) : null}

      {(statsMode || editMode || quickLogMode) && (
        <View style={styles.energyScaffoldingContainer}>
          <View style={styles.energyScaffoldingButton}>
            <Text style={styles.energyScaffoldingButtonText}>
              {statsMode ? 'Stats Mode' : editMode ? 'Edit Mode' : 'Quick Log Mode'}
            </Text>
          </View>
          <TouchableOpacity
            testID="exit-mode"
            onPress={() => {
              setStatsMode(false);
              setEditMode(false);
              setQuickLogMode(false);
            }}
            style={styles.archiveEnergyButton}
          >
            <Text>Exit</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Modals */}
      <GoalModal
        visible={goalModalVisible}
        habit={selectedHabit}
        onClose={() => setGoalModalVisible(false)}
        onUpdateGoal={handleUpdateGoal}
        onLogUnit={handleLogUnit}
        onUpdateHabit={handleUpdateHabit}
      />
      <StatsModal
        visible={statsModalVisible}
        habit={selectedHabit}
        stats={selectedHabit ? generateStatsForHabit(selectedHabit) : null}
        onClose={() => setStatsModalVisible(false)}
      />
      <HabitSettingsModal
        visible={settingsModalVisible}
        habit={selectedHabit}
        onClose={() => setSettingsModalVisible(false)}
        onUpdate={handleUpdateHabit}
        onDelete={handleDeleteHabit}
        onOpenReorderModal={handleOpenReorderModal}
        allHabits={habits}
      />
      <ReorderHabitsModal
        visible={reorderModalVisible}
        habits={habits}
        onClose={() => setReorderModalVisible(false)}
        onSaveOrder={handleSaveHabitOrder}
      />
      <MissedDaysModal
        visible={missedDaysModalVisible}
        habit={selectedHabit}
        missedDays={[new Date(), new Date(Date.now() - 86400000)]} // Example: today and yesterday
        onClose={() => setMissedDaysModalVisible(false)}
        onBackfill={handleBackfillMissedDays}
        onNewStartDate={handleSetNewStartDate}
      />
      <OnboardingModal
        visible={onboardingVisible}
        onClose={() => setOnboardingVisible(false)}
        onSaveHabits={handleOnboardingSave}
      />
      {emojiPickerVisible && (
        <Modal transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.emojiPickerModal}>
              <View style={styles.emojiPickerHeader}>
                <Text style={styles.emojiPickerTitle}>Select Icon</Text>
                <TouchableOpacity
                  style={styles.closeEmojiPicker}
                  onPress={() => {
                    setEmojiPickerVisible(false);
                    setEmojiHabitIndex(null);
                  }}
                >
                  <Text style={styles.closeEmojiPickerText}>×</Text>
                </TouchableOpacity>
              </View>
              <EmojiSelector
                onEmojiSelected={handleEmojiSelect}
                showSearchBar
                columns={6}
                // @ts-ignore typing issue
                emojiSize={28}
              />
            </View>
          </View>
        </Modal>
      )}
    </SafeAreaView>
  );
};

export default HabitsScreen;
