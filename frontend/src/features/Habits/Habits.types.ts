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
  /** Carryover habits predate the program and render on negative laps. */
  is_carryover?: boolean;

  // --- Client-only fields (not from API) ---
  completions?: Completion[];
  /** Device-local notification IDs managed by expo-notifications. */
  notificationIds?: string[];
  last_completion_date?: Date;
  revealed?: boolean;
  /** Marks the offline/demo placeholder tiles, whose hard-coded start dates are not a real program start. */
  isDemoSeed?: boolean;
  /**
   * This row's habit and goal ids were minted on this device; no server row
   * answers to them yet. Distinct from `isDemoSeed`: a demo tile must never
   * reach the on-disk cache, while a client-minted row is the user's real
   * data and must.
   */
  hasClientMintedIds?: boolean;
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

/**
 * What a re-scaffolding pass decided about one habit.
 *
 * The onboarding modal hands back a fresh list of picks, and until now that
 * list was the whole story: every row was created. It cannot be, once the user
 * already has habits -- the server rejects a second habit under a name the
 * caller already owns, so a re-entered name used to come back a swallowed 409
 * with the user's new rating discarded and the stale row untouched. A pick has
 * to say which existing row it means, and a row the picks do not name has to
 * say what becomes of it.
 *
 * The kinds are deliberately five rather than three, because "kept" hides two
 * different promises and "not picked" hides two different outcomes:
 *
 * - `new` is the only kind that mints ids on this device, and the only one that
 *   POSTs. It carries no `habitId` because there is no row to carry.
 * - `re-rated` adopts the pick's energy ratings, icon, stage and staggered
 *   start date onto the existing row, keeping its id, goals, completions,
 *   streak and unlock state.
 * - `brought-along` is `re-rated` for a habit the user carries from before the
 *   program: it takes the new ratings and icon but keeps its own start date and
 *   stage, because that date is when the habit began in the user's life rather
 *   than a program date, and the negative lap is where it renders.
 * - `retained` is a row the picks never mentioned. It is left exactly as it is.
 *   Omitting a habit is not asking to lose it: the DELETE cascades goals and
 *   completions server-side and cannot be undone, so an omission must never
 *   reach it.
 * - `released` is the explicit, confirmed choice to let a habit go, with the
 *   history that goes with it. Nothing derives this kind -- a caller has to
 *   state it.
 */
export type HabitDisposition =
  | { readonly kind: 'new'; readonly habit: OnboardingHabit }
  | { readonly kind: 're-rated'; readonly habitId: number; readonly habit: OnboardingHabit }
  | { readonly kind: 'brought-along'; readonly habitId: number; readonly habit: OnboardingHabit }
  | { readonly kind: 'retained'; readonly habitId: number }
  | { readonly kind: 'released'; readonly habitId: number };

/**
 * One decision per habit the pass touches, in the order the user revealed them.
 * Order is load-bearing: it is the order the merged program lap is stamped in.
 */
export type HabitMergePlan = readonly HabitDisposition[];

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
  /** Long-press-a-star fill logging; ``date`` backfills a past day (omit for today). */
  onLogUnit?: (_habitId: number, _amount: number, _date?: Date) => void;
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
  /** ``isCarryover`` slots the new habit onto the negative laps; defaults to a program add. */
  addHabit: (_input: AddHabitInput, _isCarryover?: boolean) => Promise<void>;
  saveHabitOrder: (_orderedHabits: Habit[]) => void;
  backfillMissedDays: (_habitId: number, _days: Date[]) => void;
  setNewStartDate: (_habitId: number, _newDate: Date) => void;
  onboardingSave: (_newHabits: OnboardingHabit[]) => Promise<void>;
  iconPress: (_index: number) => void;
  emojiSelect: (_emoji: string) => void;
  revealAllHabits: () => void;
  lockUntouchedHabits: () => void;
  unlockHabit: (_habitId: number) => void;
}

export interface HabitsUIFlags {
  showEnergyCTA: boolean;
  showArchiveMessage: boolean;
  archiveEnergyCTA: () => void;
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
