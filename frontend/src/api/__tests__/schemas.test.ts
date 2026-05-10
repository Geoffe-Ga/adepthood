/* eslint-env jest */
/* global describe, it, expect */
import { goalCompletionSchema, goalSchema, habitSchema, habitWithGoalsSchema } from '../schemas';

const baseGoal = {
  id: 1,
  habit_id: 1,
  title: 'Drink water',
  tier: 'clear',
  target: 8,
  target_unit: 'glasses',
  frequency: 1,
  frequency_unit: 'per_day',
  is_additive: true,
};

const baseHabit = {
  id: 1,
  name: 'Hydrate',
  icon: '💧',
  start_date: '2024-01-15',
  energy_cost: 1,
  energy_return: 2,
  milestone_notifications: false,
  stage: 'aptitude',
  streak: 0,
};

describe('goalCompletionSchema timestamp validation', () => {
  it('accepts a UTC-suffixed ISO-8601 timestamp', () => {
    expect(() =>
      goalCompletionSchema.parse({ id: 1, timestamp: '2026-05-09T22:31:22Z', completed_units: 1 }),
    ).not.toThrow();
  });

  it('accepts a numeric-offset ISO-8601 timestamp (Python isoformat default)', () => {
    expect(() =>
      goalCompletionSchema.parse({
        id: 2,
        timestamp: '2026-05-09T22:31:22+00:00',
        completed_units: 1,
      }),
    ).not.toThrow();
  });

  it('rejects a free-form string that would silently produce Invalid Date', () => {
    expect(() =>
      goalCompletionSchema.parse({ id: 3, timestamp: 'not-a-date', completed_units: 1 }),
    ).toThrow();
  });

  it('rejects a date-only string (no time component)', () => {
    expect(() =>
      goalCompletionSchema.parse({ id: 4, timestamp: '2026-05-09', completed_units: 1 }),
    ).toThrow();
  });

  it('rejects an empty string (the previous schema accepted this)', () => {
    expect(() =>
      goalCompletionSchema.parse({ id: 5, timestamp: '', completed_units: 1 }),
    ).toThrow();
  });
});

describe('goalCompletionSchema completed_units validation', () => {
  it('accepts zero (a recorded ``did_complete=false`` row)', () => {
    expect(() =>
      goalCompletionSchema.parse({ id: 1, timestamp: '2026-05-09T22:31:22Z', completed_units: 0 }),
    ).not.toThrow();
  });

  it('accepts a positive amount', () => {
    expect(() =>
      goalCompletionSchema.parse({
        id: 2,
        timestamp: '2026-05-09T22:31:22Z',
        completed_units: 5.5,
      }),
    ).not.toThrow();
  });

  it('rejects a negative amount (domain invariant)', () => {
    expect(() =>
      goalCompletionSchema.parse({
        id: 3,
        timestamp: '2026-05-09T22:31:22Z',
        completed_units: -5,
      }),
    ).toThrow();
  });
});

describe('goalSchema embedded completions', () => {
  it('accepts a goal with no embedded completions (back-compat)', () => {
    expect(() => goalSchema.parse(baseGoal)).not.toThrow();
  });

  it('accepts a goal with valid embedded completions', () => {
    expect(() =>
      goalSchema.parse({
        ...baseGoal,
        completions: [
          { id: 1, timestamp: '2026-05-09T22:31:22Z', completed_units: 3 },
          { id: 2, timestamp: '2026-05-10T08:00:00Z', completed_units: 1 },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects a goal whose nested completion has a malformed timestamp', () => {
    expect(() =>
      goalSchema.parse({
        ...baseGoal,
        completions: [{ id: 1, timestamp: 'oops', completed_units: 1 }],
      }),
    ).toThrow();
  });
});

describe('habitSchema start_date validation', () => {
  it('accepts a valid YYYY-MM-DD date', () => {
    expect(() => habitSchema.parse(baseHabit)).not.toThrow();
  });

  it('rejects a free-form string', () => {
    expect(() => habitSchema.parse({ ...baseHabit, start_date: 'tomorrow' })).toThrow();
  });

  it('rejects a full datetime in the date-only field', () => {
    expect(() => habitSchema.parse({ ...baseHabit, start_date: '2024-01-15T00:00:00Z' })).toThrow();
  });
});

describe('habitWithGoalsSchema end-to-end', () => {
  it('accepts a fully-populated payload with embedded completions', () => {
    expect(() =>
      habitWithGoalsSchema.parse({
        ...baseHabit,
        goals: [
          {
            ...baseGoal,
            completions: [{ id: 9, timestamp: '2026-05-09T22:31:22Z', completed_units: 2 }],
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects when a nested completion violates the timestamp contract', () => {
    expect(() =>
      habitWithGoalsSchema.parse({
        ...baseHabit,
        goals: [
          {
            ...baseGoal,
            completions: [{ id: 9, timestamp: 'broken', completed_units: 2 }],
          },
        ],
      }),
    ).toThrow();
  });
});
