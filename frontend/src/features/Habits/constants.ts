/**
 * The onboarding habit cap and Habits-grid sizing constant.
 *
 * Ten is a causally-coupled product constant — it simultaneously drives the
 * onboarding cap, the Habits list page size, and the tile-layout row divisor
 * (see `useTileLayout`). These must move together, so they all derive from this
 * single value rather than repeating the literal. The regular Add Habit flow is
 * not capped here; the backend enforces a separate, higher per-user ceiling.
 */
export const MAX_HABITS = 10;

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
