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
  /**
   * Persisted display order. The list endpoint sorts ascending by this
   * value, so the reorder modal needs to write it back through ``PUT
   * /habits/{id}`` for the order to survive a logout. ``null`` means
   * "unordered" — the backend buckets nulls last in ascending sort.
   */
  sort_order?: number | null;

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
  /** Atomic all-tiers unit update — one batch PUT, one rollback (#289). */
  onUpdateGoalUnits: (
    _habitId: number,
    _changes: Partial<Pick<Goal, 'target_unit' | 'frequency' | 'frequency_unit'>>,
  ) => void;
  /** ``date`` backfills a past day; omit to log against today. */
  onLogUnit: (_habitId: number, _amount: number, _date?: Date) => void;
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
  // Handlers take the tile's own habit / index so the parent can pass stable
  // (useCallback) references shared across all rows; the tile binds them to its
  // habit internally. This keeps React.memo effective — a single-habit update
  // re-renders only that row (issue #468).
  onOpenGoals?: (_habit: Habit) => void;
  onLongPress?: (_habit: Habit) => void;
  onIconPress?: (_index: number) => void;
  onUnlockHabit?: (_habitId: number) => void;
  /**
   * IANA timezone used to bucket completions into the user's calendar day
   * for the progress bar / "Achieved Today" display. Defaults to UTC when
   * absent so legacy tests render without an auth context.
   */
  tz?: string;
  /** Border/accent color; falls back to ``STAGE_COLORS[habit.stage]`` when omitted. */
  stageColor?: string;
  /** Global (page-offset) index passed to ``onIconPress``; defaults to 0. */
  globalIndex?: number;
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

export interface AddHabitInput {
  name: string;
  icon: string;
  energy_cost?: number;
  energy_return?: number;
}

export interface HabitsActions {
  loadHabits: () => Promise<void>;
  updateGoal: (_habitId: number, _updatedGoal: Goal) => void;
  updateGoalUnits: (
    _habitId: number,
    _changes: Partial<Pick<Goal, 'target_unit' | 'frequency' | 'frequency_unit'>>,
  ) => void;
  /** ``date`` backfills a past day; omit to log against today. */
  logUnit: (_habitId: number, _amount: number, _date?: Date) => void;
  updateHabit: (_updatedHabit: Habit) => void;
  deleteHabit: (_habitId: number) => void;
  addHabit: (_input: AddHabitInput) => Promise<void>;
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
