//------------------
// Type Definitions
//------------------

export type HabitScreenMode = 'normal' | 'stats' | 'quickLog' | 'edit';

export interface Habit {
  // --- Fields from API (matches backend HabitWithGoals schema) ---
  id: number;
  stage: string;
  name: string;
  icon: string;
  streak: number;
  energy_cost: number;
  energy_return: number;
  start_date: Date;
  goals: Goal[];
  notificationTimes?: string[];
  notificationFrequency?: 'daily' | 'weekly' | 'custom' | 'off';
  notificationDays?: string[];
  milestoneNotifications?: boolean;

  // --- Client-only fields (not from API) ---
  /**
   * Total progress toward the habit goals.
   *
   * This value is derived from the sum of all completion units
   * recorded in the `completions` array and should not be set
   * directly. It is kept optional to encourage calculating the
   * current progress programmatically via `calculateHabitProgress`.
   */
  progress?: number;
  completions?: Completion[];
  /** Device-local notification IDs managed by expo-notifications. */
  notificationIds?: string[];
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
  goal_group_id?: number | null;
}

export interface GoalGroup {
  id: number;
  name: string;
  icon?: string | null;
  description?: string | null;
  user_id?: number | null;
  shared_template: boolean;
  source?: string | null;
  goals: Goal[];
}

export interface Completion {
  id?: string;
  timestamp: Date;
  completed_units: number;
}

export interface HabitStatsData {
  dates: string[];
  values: number[];
  completionsByDay: number[];
  dayLabels: string[];
  longestStreak: number;
  currentStreak: number;
  totalCompletions: number;
  completionRate: number;
  completionDates: string[];
}

export interface OnboardingHabit {
  id: string;
  name: string;
  icon: string;
  energy_cost: number;
  energy_return: number;
  stage: string;
  start_date: Date;
  goal_group_id?: number | null;
}

export interface GoalModalProps {
  visible: boolean;
  habit: Habit | null;
  onClose: () => void;
  onUpdateGoal: (_habitId: number, _updatedGoal: Goal) => void;
  onLogUnit: (_habitId: number, _amount: number) => void;
  onUpdateHabit: (_updatedHabit: Habit) => void;
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
  locked?: boolean;
  onOpenGoals?: () => void;
  onLongPress?: () => void;
  onIconPress?: () => void;
  onUnlockHabit?: (_habitId: number) => void;
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

export interface HabitsActions {
  loadHabits: () => Promise<void>;
  updateGoal: (_habitId: number, _updatedGoal: Goal) => void;
  logUnit: (_habitId: number, _amount: number) => void;
  updateHabit: (_updatedHabit: Habit) => void;
  deleteHabit: (_habitId: number) => void;
  saveHabitOrder: (_orderedHabits: Habit[]) => void;
  backfillMissedDays: (_habitId: number, _days: Date[]) => void;
  setNewStartDate: (_habitId: number, _newDate: Date) => void;
  onboardingSave: (_newHabits: OnboardingHabit[]) => Promise<void>;
  iconPress: (_index: number) => void;
  emojiSelect: (_emoji: string) => void;
  revealAllHabits: () => void;
  lockUnstartedHabits: () => void;
  unlockHabit: (_habitId: number) => void;
}

export interface HabitsUIFlags {
  showEnergyCTA: boolean;
  showArchiveMessage: boolean;
  archiveEnergyCTA: () => void;
  emojiHabitIndex: number | null;
}

export interface UseHabitsReturn {
  habits: Habit[];
  loading: boolean;
  error: string | null;
  selectedHabit: Habit | null;
  setSelectedHabit: (_habit: Habit | null) => void;
  mode: HabitScreenMode;
  setMode: (_mode: HabitScreenMode) => void;
  actions: HabitsActions;
  ui: HabitsUIFlags;
  /** Exposed only for testing — do not use in production code. */
  setHabitsForTesting: (_habits: Habit[]) => void;
}
