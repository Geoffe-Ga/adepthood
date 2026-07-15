/**
 * Pure parser for the energy-cost / energy-return text inputs in the
 * habit settings and Add Habit modals.  Lives in its own file so unit
 * tests can import without pulling in the RN component tree.
 *
 * BUG-FE-HABIT-201: the prior ``parseInt(text) || 0`` silently coerced
 * "foo", "1.5", "" all to ``0`` and accepted them as valid energy
 * values.  Strict integer regex + range guard rejects the malformed
 * cases so the caller can surface a validation error instead of writing
 * 0 to the planner.
 */
// The -10..10 range is also spelled out in the user-facing validation
// copy (``EnergyCostReturnEditor``'s ENERGY_VALIDATION_NOTE); keep the two
// in sync.
const ENERGY_MIN = -10;
const ENERGY_MAX = 10;

export const parseEnergyValue = (text: string): number | null => {
  if (text.trim() === '') return null;
  if (!/^-?\d+$/.test(text.trim())) return null;
  const value = Number.parseInt(text.trim(), 10);
  return value >= ENERGY_MIN && value <= ENERGY_MAX ? value : null;
};
