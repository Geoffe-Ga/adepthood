/* eslint-env jest */
/* global describe, it, expect */

/**
 * Unit tests for the pure-function tier extracted from the modal
 * components in PR #302.  ``onboardingValidation`` is intentionally
 * RN-free so this test file imports the helpers directly without
 * mocking ESM-only RN modules.  ``parseEnergyValue`` lives in
 * ``HabitSettingsModal`` -- which DOES pull in RN -- so the test
 * imports it via a thin barrel module that re-exports without the
 * heavy component tree.
 */
import type { OnboardingHabit } from '../../Habits.types';
import {
  HABIT_NAME_MAX_LENGTH,
  sanitizeHabitName,
  validateAndAddHabit,
} from '../onboardingValidation';
import { parseEnergyValue } from '../parseEnergyValue';

describe('parseEnergyValue (BUG-FE-HABIT-201)', () => {
  it('accepts a valid integer inside the [-10, 10] window', () => {
    expect(parseEnergyValue('5')).toBe(5);
    expect(parseEnergyValue('0')).toBe(0);
    expect(parseEnergyValue('-10')).toBe(-10);
    expect(parseEnergyValue('10')).toBe(10);
  });

  it('returns null for an empty / whitespace string (mid-edit allowance)', () => {
    expect(parseEnergyValue('')).toBeNull();
    expect(parseEnergyValue('   ')).toBeNull();
  });

  it('rejects non-integer garbage that previously coerced to 0', () => {
    // The original ``parseInt(text) || 0`` silently turned every one of
    // these into a legitimate 0.  The new parser surfaces them as
    // ``null`` so the caller can show a validation error.
    expect(parseEnergyValue('foo')).toBeNull();
    expect(parseEnergyValue('abc')).toBeNull();
    expect(parseEnergyValue('1.5')).toBeNull();
    expect(parseEnergyValue('1.5e10')).toBeNull();
    expect(parseEnergyValue('NaN')).toBeNull();
    expect(parseEnergyValue('Infinity')).toBeNull();
  });

  it('rejects integers outside the [-10, 10] window', () => {
    expect(parseEnergyValue('-11')).toBeNull();
    expect(parseEnergyValue('11')).toBeNull();
    expect(parseEnergyValue('1000')).toBeNull();
  });
});

describe('sanitizeHabitName (BUG-FE-HABIT-105)', () => {
  it('passes a plain valid name through unchanged', () => {
    expect(sanitizeHabitName('Meditate')).toBe('Meditate');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeHabitName('  Meditate  ')).toBe('Meditate');
  });

  it('strips ASCII control characters (newlines, tabs, NUL, DEL)', () => {
    expect(sanitizeHabitName('Hello\nWorld')).toBe('HelloWorld');
    expect(sanitizeHabitName('Hello\tWorld')).toBe('HelloWorld');
    expect(sanitizeHabitName('Hello\x00World\x7f!')).toBe('HelloWorld!');
  });

  it(`clamps to the ${HABIT_NAME_MAX_LENGTH}-char max length`, () => {
    const result = sanitizeHabitName('a'.repeat(HABIT_NAME_MAX_LENGTH + 40));
    expect(result.length).toBe(HABIT_NAME_MAX_LENGTH);
  });

  it('returns empty string when input contains only control characters', () => {
    expect(sanitizeHabitName('\n\t\r ')).toBe('');
  });
});

function fakeHabit(name: string): OnboardingHabit {
  return {
    id: `id-${name}`,
    name,
    icon: '⭐',
    energy_cost: 0,
    energy_return: 0,
    stage: 'Beige',
    start_date: new Date(),
  };
}

describe('validateAndAddHabit (BUG-FE-HABIT-105)', () => {
  it("returns 'noop' for an empty / whitespace-only name", () => {
    expect(validateAndAddHabit('', [])).toEqual({ kind: 'noop' });
    expect(validateAndAddHabit('   ', [])).toEqual({ kind: 'noop' });
  });

  it("returns 'add' with the sanitized name for a valid new habit", () => {
    const result = validateAndAddHabit('  Meditate  ', []);
    expect(result.kind).toBe('add');
    if (result.kind === 'add') {
      expect(result.habit.name).toBe('Meditate');
    }
  });

  it("returns 'error' when a case-insensitive duplicate exists", () => {
    const existing = [fakeHabit('Meditate')];
    const result = validateAndAddHabit('meditate', existing);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/already added/i);
    }
  });

  it("returns 'error' when the MAX_HABITS limit is reached", () => {
    const fullList = Array.from({ length: 10 }, (_, i) => fakeHabit(`H${i}`));
    const result = validateAndAddHabit('NewOne', fullList);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toMatch(/10-habit limit/i);
    }
  });
});
