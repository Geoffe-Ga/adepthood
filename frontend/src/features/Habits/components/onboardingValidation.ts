/**
 * Pure validation + sanitisation helpers for the OnboardingModal.
 *
 * Kept in a separate file so unit tests can import them without pulling
 * in the modal's React Native + reanimated + gesture-handler tree.  The
 * modal re-exports the same names for its own use.
 */
import { DEFAULT_ICONS, MAX_HABITS } from '../constants';
import type { OnboardingHabit } from '../Habits.types';

const DEFAULT_ENERGY = 5;

// BUG-FE-HABIT-105: maximum length for an onboarding habit name.  TextInput
// also enforces the cap; the parse-time guard is defence in depth so a
// programmatic ``setHabits`` cannot smuggle a 10k-char name past the UI.
export const HABIT_NAME_MAX_LENGTH = 80;

let habitIdCounter = 0;

export const generateHabitId = (): string => {
  habitIdCounter += 1;
  // ``Date.now()`` alone collided on rapid taps within the same
  // millisecond (common on web with React 18 auto-batching).  Pairing
  // with a monotonically-increasing counter guarantees uniqueness even
  // when ``Date.now()`` is identical.
  return `${Date.now()}-${habitIdCounter}`;
};

export const sanitizeHabitName = (raw: string): string => {
  // Strip ASCII control characters (0x00-0x1F + 0x7F) including newlines
  // and tabs; the displayed habit name is single-line.  Implemented with
  // ``charCodeAt`` so ESLint's ``no-control-regex`` stays clean.
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code <= 31 || code === 127) continue;
    out += raw[i];
  }
  return out.trim().slice(0, HABIT_NAME_MAX_LENGTH);
};

export const createNewHabit = (name: string): OnboardingHabit => ({
  id: generateHabitId(),
  name: sanitizeHabitName(name),
  icon: DEFAULT_ICONS[Math.floor(Math.random() * DEFAULT_ICONS.length)] ?? '⭐',
  energy_cost: DEFAULT_ENERGY,
  energy_return: DEFAULT_ENERGY,
  stage: 'Beige',
  start_date: new Date(),
});

// Three-way discriminated union by ``kind`` makes the call site easier
// to read than the prior mixed shape.
export type ValidateAddHabitResult =
  | { kind: 'noop' }
  | { kind: 'error'; message: string }
  | { kind: 'add'; habit: OnboardingHabit };

export const validateAndAddHabit = (
  raw: string,
  habits: OnboardingHabit[],
): ValidateAddHabitResult => {
  const cleaned = sanitizeHabitName(raw);
  if (cleaned === '') return { kind: 'noop' };
  if (habits.length >= MAX_HABITS) {
    return {
      kind: 'error',
      message: `You've hit the ${MAX_HABITS}-habit limit for onboarding. Remove one you don't need to add a different habit.`,
    };
  }
  const lower = cleaned.toLowerCase();
  if (habits.some((h) => h.name.toLowerCase() === lower)) {
    return { kind: 'error', message: "You've already added that one. Pick a different name." };
  }
  return { kind: 'add', habit: createNewHabit(cleaned) };
};
