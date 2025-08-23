/* eslint-disable no-unused-vars */
//------------------
// Type Definitions
//------------------

export interface Habit {
  id?: number;
  stage: string;
  name: string;
  icon: string;
  streak: number;
  energy_cost: number;
  energy_return: number;
  /**
   * Total progress toward the habit goals.
   *
   * This value is derived from the sum of all completion units
   * recorded in the `completions` array and should not be set
   * directly. It is kept optional to encourage calculating the
   * current progress programmatically via `calculateHabitProgress`.
   */
  progress?: number;
  start_date: Date;
  goals: Goal[];
  completions?: Completion[];
  notificationIds?: string[];
  notificationTimes?: string[];
  notificationFrequency?: 'daily' | 'weekly' | 'custom' | 'off';
  notificationDays?: string[];
  milestoneNotifications?: boolean;
  last_completion_date?: Date;
  revealed?: boolean;
}

export interface Goal {
  id?: number;
  title: string;
  tier: 'low' | 'clear' | 'stretch';
  target: number;
  target_unit: string;
  frequency: number;
  frequency_unit: string;
  days_of_week?: string[];
  is_additive: boolean;
}

export interface Completion {
  id?: number;
  timestamp: Date;
  completed_units: number;
}

export interface HabitStatsData {
  dates: string[];
  values: number[];
  completionsByDay: number[];
  dayLabels: string[];
  longestStreak: number;
  totalCompletions: number;
  completionRate: number;
}

export interface OnboardingHabit {
  name: string;
  icon: string;
  energy_cost: number;
  energy_return: number;
  stage: string;
  start_date: Date;
}

export interface GoalModalProps {
  visible: boolean;
  habit: Habit | null;
  onClose: () => void;
  onUpdateGoal: (_habitId: number, _updatedGoal: Goal) => void;
  onLogUnit: (_habitId: number, _amount: number) => void;
}

export interface StatsModalProps {
  visible: boolean;
  habit: Habit | null;
  stats: HabitStatsData | null;
  onClose: () => void;
}

export interface EditableGoalProps {
  goal: Goal;
  onUpdate: (_updatedGoal: Goal) => void;
  isEditing: boolean;
}

export interface HabitTileProps {
  habit: Habit;
  onOpenGoals: () => void;
  onLogUnit: () => void;
  onOpenStats: () => void;
  onLongPress: () => void;
}

export interface HabitSettingsModalProps {
  visible: boolean;
  habit: Habit | null;
  onClose: () => void;
  onUpdate: (_updatedHabit: Habit) => void;
  onDelete: (_habitId: number) => void;
  onOpenReorderModal: (_habits: Habit[]) => void;
  allHabits: Habit[];
}

export interface MissedDaysModalProps {
  visible: boolean;
  habit: Habit | null;
  missedDays: Date[];
  onClose: () => void;
  onBackfill: (_habitId: number, _days: Date[]) => void;
  onNewStartDate: (_habitId: number, _newStartDate: Date) => void;
}

export interface OnboardingModalProps {
  visible: boolean;
  onClose: () => void;
  onSaveHabits: (_habits: OnboardingHabit[]) => void;
}

export interface ReorderHabitsModalProps {
  visible: boolean;
  habits: Habit[];
  onClose: () => void;
  onSaveOrder: (_habits: Habit[]) => void;
}
