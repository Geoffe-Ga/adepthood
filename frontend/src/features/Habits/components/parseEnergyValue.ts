/**
 * Pure parser for the energy-cost / energy-return text inputs in the
 * habit settings modal.  Lives in its own file so unit tests can import
 * without pulling in the RN component tree.
 *
 * BUG-FE-HABIT-201: the prior ``parseInt(text) || 0`` silently coerced
 * "foo", "1.5", "" all to ``0`` and accepted them as valid energy
 * values.  Strict integer regex + range guard rejects the malformed
 * cases so the caller can surface a validation error instead of writing
 * 0 to the planner.
 */
// Bounds mirror those expressed in ``HabitSettingsModal``; kept here so
// the parser stays a single source of truth across the input row + the
// dedicated unit tests.
const ENERGY_MIN = -10;
const ENERGY_MAX = 10;

export const parseEnergyValue = (text: string): number | null => {
  if (text.trim() === '') return null;
  if (!/^-?\d+$/.test(text.trim())) return null;
  const value = Number.parseInt(text.trim(), 10);
  return value >= ENERGY_MIN && value <= ENERGY_MAX ? value : null;
};
