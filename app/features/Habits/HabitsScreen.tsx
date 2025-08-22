// HabitsScreen.tsx

import * as Notifications from 'expo-notifications';
import React, { useEffect, useState } from 'react';
import { Alert, FlatList, Text, TouchableOpacity, View } from 'react-native';

import { STAGE_COLORS } from '../../constants/stageColors';

import GoalModal from './components/GoalModal';
import HabitSettingsModal from './components/HabitSettingsModal';
import MissedDaysModal from './components/MissedDaysModal';
import OnboardingModal from './components/OnboardingModal';
import ReorderHabitsModal from './components/ReorderHabitsModal';
import StatsModal from './components/StatsModal';
import { HABIT_DEFAULTS } from './HabitDefaults';
import styles from './Habits.styles';
import type { Completion, Goal, Habit, HabitStatsData, OnboardingHabit } from './Habits.types';
import HabitTile from './HabitTile';

//------------------
// Constants & Helpers
//------------------

export const STAGE_ORDER = [
  'Beige',
  'Purple',
  'Red',
  'Blue',
  'Orange',
  'Green',
  'Yellow',
  'Turquoise',
  'Ultraviolet',
  'Clear Light',
];

export const getTierColor = (tier: 'low' | 'clear' | 'stretch') => {
  switch (tier) {
    case 'low':
      return '#bc845d';
    case 'clear':
      return '#807f66';
    case 'stretch':
      return '#b0ae91';
    default:
      return '#dad9d4';
  }
};

// Victory color - shown when Clear goal is met and moving to Stretch goal
export const VICTORY_COLOR = '#27ae60';

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
  const [hours, minutes] = notificationTime.split(':').map(Number);

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
      hour: hours,
      minute: minutes,
      repeats: true,
    };

    return [await schedule(dailyTrigger)];
  }

  if (habit.notificationFrequency === 'weekly') {
    const weeklyTrigger: Notifications.WeeklyTriggerInput = {
      weekday: 1,
      hour: hours,
      minute: minutes,
      repeats: true,
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
        weekday,
        hour: hours,
        minute: minutes,
        repeats: true,
      };

      const id = await schedule(customTrigger);
      notificationIds.push(id);
    }

    return notificationIds;
  }

  const fallbackTrigger: Notifications.DailyTriggerInput = {
    hour: hours,
    minute: minutes,
    repeats: true,
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
export const calculateProgressIncrements = (goal: Goal): number[] => {
  const { target } = goal;

  if (target <= 5) {
    return Array.from({ length: target }, (_, i) => i + 1);
  } else if (target <= 10) {
    return Array.from({ length: 5 }, (_, i) => ((i + 1) * target) / 5);
  } else if (target <= 100) {
    return Array.from({ length: 5 }, (_, i) => Math.ceil(((i + 1) * target) / 5));
  } else {
    // For very large targets, show 5 evenly spaced markers
    const increment = Math.ceil(target / 5);
    return Array.from({ length: 4 }, (_, i) => (i + 1) * increment);
  }
};

export const getGoalTier = (
  habit: Habit,
): {
  currentGoal: Goal;
  nextGoal: Goal | null;
  completedAllGoals: boolean;
} => {
  const sortedGoals = [...habit.goals].sort((a, b) => {
    const tierOrder = { low: 1, clear: 2, stretch: 3 };
    return tierOrder[a.tier] - tierOrder[b.tier];
  });

  const totalProgress = calculateHabitProgress(habit);
  let currentGoal = sortedGoals[0];
  let nextGoal: Goal | null = null;
  let completedAllGoals = false;

  // For additive goals - find which goal tier we're currently working on
  if (currentGoal.is_additive) {
    if (totalProgress >= getGoalTarget(sortedGoals[2])) {
      // We've completed all goals including stretch
      currentGoal = sortedGoals[2];
      completedAllGoals = true;
    } else if (totalProgress >= getGoalTarget(sortedGoals[1])) {
      // We're working on the stretch goal
      currentGoal = sortedGoals[1];
      nextGoal = sortedGoals[2];
    } else if (totalProgress >= getGoalTarget(sortedGoals[0])) {
      // We've completed the low goal, working on clear goal
      currentGoal = sortedGoals[0];
      nextGoal = sortedGoals[1];
    } else {
      // We're still working on the low goal
      currentGoal = sortedGoals[0];
      // Don't set nextGoal to sortedGoals[0], keep it null for the lowest tier
    }
  } else {
    // For subtractive goals - find which goal tier we're currently at
    // For subtractive, lower target is better (e.g., 0 drinks is better than 3)
    const lowTarget = getGoalTarget(sortedGoals[0]);
    const clearTarget = getGoalTarget(sortedGoals[1]);
    const stretchTarget = getGoalTarget(sortedGoals[2]);

    if (totalProgress <= stretchTarget) {
      // We're at or better than the stretch goal
      currentGoal = sortedGoals[2];
      completedAllGoals = true;
    } else if (totalProgress <= clearTarget) {
      // We're at or better than the clear goal
      currentGoal = sortedGoals[1];
      nextGoal = sortedGoals[2];
    } else if (totalProgress <= lowTarget) {
      // We're at or better than the low goal
      currentGoal = sortedGoals[0];
      nextGoal = sortedGoals[1];
    } else {
      // We haven't reached any goal yet
      currentGoal = sortedGoals[0];
      // Don't set nextGoal to sortedGoals[0], keep it null if no goal is reached
    }
  }

  return { currentGoal, nextGoal, completedAllGoals };
};

// Calculate the target value for a goal based on frequency
export const getGoalTarget = (goal: Goal): number => {
  if (!goal) return 0;

  // For per_day goals, return the target directly
  if (goal.frequency_unit === 'per_day') {
    return goal.target;
  }

  // For per_week goals, divide by 7 to get daily equivalent
  if (goal.frequency_unit === 'per_week') {
    return (goal.target / 7) * goal.frequency;
  }

  // For per_month goals, divide by 30 to get daily equivalent (approximation)
  if (goal.frequency_unit === 'per_month') {
    return (goal.target / 30) * goal.frequency;
  }

  // Default case
  return goal.target;
};

// Calculate total progress from completions
export const calculateHabitProgress = (habit: Habit): number => {
  if (!habit.completions || habit.completions.length === 0) {
    return habit.progress || 0; // Return the default progress if no completions
  }

  // Sum all completion units to calculate total progress
  return habit.completions.reduce((sum, completion) => sum + completion.completed_units, 0);
};

// Calculate progress as a percentage for UI display
export const calculateProgressPercentage = (
  habit: Habit,
  currentGoal: Goal,
  nextGoal: Goal | null,
): number => {
  const totalProgress = calculateHabitProgress(habit);
  const isAdditive = currentGoal.is_additive;

  // For additive goals
  if (isAdditive) {
    const currentTarget = getGoalTarget(currentGoal);

    if (nextGoal) {
      const nextTarget = getGoalTarget(nextGoal);

      // If moving from clear to stretch goal
      if (currentGoal.tier === 'clear' && nextGoal.tier === 'stretch') {
        // If we're past the clear goal and working on stretch
        if (totalProgress >= currentTarget) {
          // Percentage between clear and stretch goals
          return Math.min(
            100,
            ((totalProgress - currentTarget) / (nextTarget - currentTarget)) * 100 + 33,
          );
        }
      }

      // If moving from low to clear goal
      if (currentGoal.tier === 'low' && nextGoal.tier === 'clear') {
        // If we're past the low goal and working on clear
        if (totalProgress >= currentTarget) {
          return Math.min(
            100,
            ((totalProgress - currentTarget) / (nextTarget - currentTarget)) * 100,
          );
        }
      }
    }

    // Standard case - percentage of current goal
    return Math.min(100, (totalProgress / currentTarget) * 100);
  }
  // For subtractive goals
  else {
    const currentTarget = getGoalTarget(currentGoal);

    // For subtractive goals, we start at 100% and decrease
    // Lower values are better (e.g., 0 drinks is better than 3)
    if (totalProgress <= currentTarget) {
      return 100; // At or below target, show as 100%
    }

    // If we exceed the target, calculate percentage decrease
    // The formula is adjusted to maintain a reasonable visual display
    const maxExcess = currentTarget * 2; // Define a reasonable maximum
    const excess = Math.min(totalProgress - currentTarget, maxExcess);
    return Math.max(0, 100 - (excess / maxExcess) * 100);
  }
};

// Get color for progress bar based on goal tier and completion state
export const getProgressBarColor = (
  habit: Habit,
  currentGoal: Goal,
  nextGoal: Goal | null,
  completedAllGoals: boolean,
): string => {
  const isAdditive = currentGoal.is_additive;
  const totalProgress = calculateHabitProgress(habit);

  // For completed goals, use victory color
  if (completedAllGoals) {
    return VICTORY_COLOR;
  }

  // For additive goals
  if (isAdditive) {
    // If we're working on the stretch goal (after completing clear)
    if (
      nextGoal &&
      currentGoal.tier === 'clear' &&
      nextGoal.tier === 'stretch' &&
      totalProgress >= getGoalTarget(currentGoal)
    ) {
      return VICTORY_COLOR;
    }

    // Otherwise use stage color
    return STAGE_COLORS[habit.stage];
  }
  // For subtractive goals
  else {
    const currentTarget = getGoalTarget(currentGoal);

    // If we're at or below the target (good), use victory color
    if (totalProgress <= currentTarget) {
      return VICTORY_COLOR;
    }

    // Otherwise use stage color
    return STAGE_COLORS[habit.stage];
  }
};

//------------------
// Main Habits Screen Component
//------------------

const HabitsScreen = () => {
  const [habits, setHabits] = useState<Habit[]>(DEFAULT_HABITS);
  const [selectedHabit, setSelectedHabit] = useState<Habit | null>(null);
  const [goalModalVisible, setGoalModalVisible] = useState(false);
  const [statsModalVisible, setStatsModalVisible] = useState(false);
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [reorderModalVisible, setReorderModalVisible] = useState(false);
  const [missedDaysModalVisible, setMissedDaysModalVisible] = useState(false);
  const [onboardingVisible, setOnboardingVisible] = useState(habits.length === 0);

  // Recalculate progress for all habits
  useEffect(() => {
    // This effect ensures progress is properly calculated from completions
    setHabits((prevHabits) =>
      prevHabits.map((habit) => ({
        ...habit,
        progress: calculateHabitProgress(habit),
      })),
    );
  }, []);

  // Register for push notifications on mount
  useEffect(() => {
    void registerForPushNotificationsAsync();
  }, []);

  // Handle goal updates
  const handleUpdateGoal = (habitId: number, updatedGoal: Goal) => {
    setHabits((prev) =>
      prev.map((h) =>
        h.id === habitId
          ? {
              ...h,
              goals: h.goals.map((goal) => (goal.id === updatedGoal.id ? updatedGoal : goal)),
            }
          : h,
      ),
    );
  };

  // Log progress units for a habit
  const handleLogUnit = (habitId: number, amount: number) => {
    setHabits((prev) =>
      prev.map((h) => {
        if (h.id === habitId) {
          const newStreak = h.streak + 1;
          const now = new Date();

          // Create a new completion record
          const newCompletion: Completion = {
            id: Math.random(), // Generate a unique ID in a real app
            timestamp: now,
            completed_units: amount,
          };

          // Add the new completion to the array
          const updatedCompletions = h.completions
            ? [...h.completions, newCompletion]
            : [newCompletion];

          // Calculate new total progress from all completions
          const newProgress = updatedCompletions.reduce(
            (sum, completion) => sum + completion.completed_units,
            0,
          );

          // Get current goal info
          const { currentGoal, nextGoal } = getGoalTier({
            ...h,
            progress: newProgress,
            completions: updatedCompletions,
          });

          // Check if we should show achievement alert
          if (currentGoal.is_additive) {
            const currentTarget = getGoalTarget(currentGoal);

            // If just achieved the low goal
            if (
              h.progress < currentTarget &&
              newProgress >= currentTarget &&
              currentGoal.tier === 'low'
            ) {
              Alert.alert(
                'Goal Achieved!',
                `You've reached your Low Goal for ${h.name}! Keep going for the Clear Goal.`,
              );
            }

            // If just achieved the clear goal
            if (
              nextGoal &&
              currentGoal.tier === 'clear' &&
              h.progress < getGoalTarget(currentGoal) &&
              newProgress >= getGoalTarget(currentGoal)
            ) {
              Alert.alert(
                'Clear Goal Achieved!',
                `Congratulations! You've reached your Clear Goal for ${h.name}! Now aim for the Stretch Goal!`,
              );
            }

            // If just achieved the stretch goal
            if (
              nextGoal &&
              currentGoal.tier === 'stretch' &&
              h.progress < getGoalTarget(currentGoal) &&
              newProgress >= getGoalTarget(currentGoal)
            ) {
              Alert.alert(
                'Stretch Goal Achieved!',
                `Amazing! You've reached your Stretch Goal for ${h.name}!`,
              );
            }
          }

          return {
            ...h,
            streak: newStreak,
            last_completion_date: now,
            progress: newProgress,
            completions: updatedCompletions,
          };
        }
        return h;
      }),
    );
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

          // Recalculate total progress
          const newProgress = updatedCompletions.reduce(
            (sum, completion) => sum + completion.completed_units,
            0,
          );

          return {
            ...habit,
            streak: habit.streak + days.length,
            last_completion_date: new Date(),
            completions: updatedCompletions,
            progress: newProgress,
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
            progress: 0,
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
      progress: 0,
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
          progress: 0,
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
          progress: 0,
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
          progress: 0,
        },
      ],
    }));

    setHabits(fullHabits);
  };

  // Render a habit tile
  const renderHabitTile = ({ item }: { item: Habit }) => (
    <HabitTile
      habit={item}
      onOpenGoals={() => {
        setSelectedHabit(item);
        setGoalModalVisible(true);
      }}
      onLogUnit={() => handleLogUnit(item.id!, 1)}
      onOpenStats={() => {
        setSelectedHabit(item);
        setStatsModalVisible(true);
      }}
      onLongPress={() => {
        setSelectedHabit(item);
        setSettingsModalVisible(true);
      }}
    />
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={habits.filter((h) => h.revealed)} // Only show revealed habits
        keyExtractor={(item) => (item.id ? item.id.toString() : Math.random().toString())}
        renderItem={renderHabitTile}
        numColumns={2}
        contentContainerStyle={styles.habitsGrid}
      />

      <TouchableOpacity
        style={styles.energyScaffoldingButton}
        onPress={() => setOnboardingVisible(true)}
      >
        <Text style={styles.energyScaffoldingButtonText}>Perform Energy Scaffolding</Text>
      </TouchableOpacity>

      {/* Modals */}
      <GoalModal
        visible={goalModalVisible}
        habit={selectedHabit}
        onClose={() => setGoalModalVisible(false)}
        onUpdateGoal={handleUpdateGoal}
        onLogUnit={handleLogUnit}
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
    </View>
  );
};

export default HabitsScreen;
