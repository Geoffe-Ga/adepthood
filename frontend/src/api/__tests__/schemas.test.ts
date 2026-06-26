/* eslint-env jest */
/* global describe, it, expect */
import {
  goalCompletionSchema,
  goalSchema,
  habitSchema,
  habitWithGoalsSchema,
  journalListResponseSchema,
  practiceItemSchema,
  practiceSessionResponseSchema,
  promptListResponseSchema,
  stageSchema,
  userPracticeSchema,
} from '../schemas';

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

describe('goalSchema days_of_week (schema-drift regression)', () => {
  it('preserves days_of_week instead of stripping it', () => {
    // Zod strips unknown keys; without the field declared, a weekly-cadence
    // goal lost its schedule on every refetch.
    const parsed = goalSchema.parse({ ...baseGoal, days_of_week: ['Mon', 'Wed'] });
    expect(parsed.days_of_week).toEqual(['Mon', 'Wed']);
  });

  it('accepts null, undefined, and absent days_of_week (API back-compat)', () => {
    expect(goalSchema.parse({ ...baseGoal, days_of_week: null }).days_of_week).toBeNull();
    expect(goalSchema.parse({ ...baseGoal, days_of_week: undefined }).days_of_week).toBeUndefined();
    expect(goalSchema.parse(baseGoal).days_of_week).toBeUndefined();
  });

  it('carries days_of_week through habitWithGoalsSchema', () => {
    const parsed = habitWithGoalsSchema.parse({
      ...baseHabit,
      goals: [{ ...baseGoal, days_of_week: ['Tue'] }],
    });
    expect(parsed.goals[0]?.days_of_week).toEqual(['Tue']);
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

describe('promptListResponseSchema total nullability', () => {
  const item = {
    week_number: 1,
    question: 'How did this week feel?',
    has_responded: true,
    response: 'Steady.',
    timestamp: '2026-05-09T22:31:22Z',
  };

  it('accepts a null total (count not requested) and keeps it null', () => {
    const parsed = promptListResponseSchema.parse({ items: [item], total: null, has_more: false });
    expect(parsed.total).toBeNull();
    // The fallback a consumer must use never produces NaN.
    expect(parsed.total ?? parsed.items.length).toBe(1);
  });

  it('accepts an integer total', () => {
    const parsed = promptListResponseSchema.parse({ items: [item], total: 42, has_more: true });
    expect(parsed.total).toBe(42);
  });

  it('rejects a non-integer total', () => {
    expect(() =>
      promptListResponseSchema.parse({ items: [item], total: 1.5, has_more: false }),
    ).toThrow();
  });

  it('rejects a non-array items envelope', () => {
    expect(() =>
      promptListResponseSchema.parse({ items: 'nope', total: null, has_more: false }),
    ).toThrow();
  });

  it('rejects an envelope missing has_more', () => {
    expect(() => promptListResponseSchema.parse({ items: [], total: null })).toThrow();
  });
});

describe('journalListResponseSchema validation', () => {
  const message = {
    id: 1,
    message: 'A quiet morning.',
    sender: 'user',
    timestamp: '2026-05-09T22:31:22Z',
    tag: 'freeform',
    practice_session_id: null,
    user_practice_id: null,
  };

  it('round-trips a well-formed envelope with nullable links intact', () => {
    const parsed = journalListResponseSchema.parse({
      items: [message, { ...message, id: 2, sender: 'bot', practice_session_id: 7 }],
      total: 2,
      has_more: false,
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.practice_session_id).toBeNull();
    expect(parsed.items[1]?.practice_session_id).toBe(7);
    expect(parsed.total).toBe(2);
  });

  it('rejects a non-array items envelope', () => {
    expect(() =>
      journalListResponseSchema.parse({ items: null, total: 0, has_more: false }),
    ).toThrow();
  });

  it('rejects an envelope missing has_more', () => {
    expect(() => journalListResponseSchema.parse({ items: [message], total: 1 })).toThrow();
  });

  it('rejects an unknown sender', () => {
    expect(() =>
      journalListResponseSchema.parse({
        items: [{ ...message, sender: 'system' }],
        total: 1,
        has_more: false,
      }),
    ).toThrow();
  });

  it('rejects a non-ISO timestamp (same contract as other timestamp columns)', () => {
    expect(() =>
      journalListResponseSchema.parse({
        items: [{ ...message, timestamp: 'not-a-date' }],
        total: 1,
        has_more: false,
      }),
    ).toThrow();
  });
});

describe('per-item paginated schemas', () => {
  const stage = {
    id: 1,
    title: 'Beige',
    subtitle: 'Survival',
    stage_number: 1,
    overview_url: 'https://example.com',
    category: 'foundation',
    aspect: 'body',
    spiral_dynamics_color: 'Beige',
    growing_up_stage: 'Archaic',
    divine_gender_polarity: 'neutral',
    relationship_to_free_will: 'reactive',
    free_will_description: 'Instinctual',
    is_unlocked: true,
    progress: 0.5,
  };

  it('stageSchema accepts a valid stage and rejects a type-flipped field', () => {
    expect(stageSchema.parse(stage).stage_number).toBe(1);
    expect(() => stageSchema.parse({ ...stage, stage_number: '1' })).toThrow();
    expect(() => stageSchema.parse({ ...stage, is_unlocked: undefined })).toThrow();
  });

  const practiceItem = {
    id: 7,
    stage_number: 2,
    name: 'Breath',
    description: 'desc',
    instructions: 'inst',
    default_duration_minutes: 10,
    submitted_by_user_id: null,
    approved: true,
  };

  it('practiceItemSchema accepts valid (mode_config optional) and rejects drift', () => {
    expect(practiceItemSchema.parse(practiceItem).submitted_by_user_id).toBeNull();
    expect(() =>
      practiceItemSchema.parse({ ...practiceItem, mode: 'meditation_timer', mode_config: {} }),
    ).not.toThrow();
    expect(() =>
      practiceItemSchema.parse({ ...practiceItem, default_duration_minutes: '10' }),
    ).toThrow();
    expect(() => practiceItemSchema.parse({ ...practiceItem, name: undefined })).toThrow();
  });

  const userPractice = {
    id: 3,
    user_id: 1,
    practice_id: 7,
    stage_number: 2,
    start_date: '2026-01-01',
    end_date: null,
  };

  it('userPracticeSchema accepts valid (optional overrides) and rejects drift', () => {
    expect(userPracticeSchema.parse(userPractice).end_date).toBeNull();
    expect(() =>
      userPracticeSchema.parse({ ...userPractice, effective_name: 'My Breath' }),
    ).not.toThrow();
    expect(() => userPracticeSchema.parse({ ...userPractice, start_date: undefined })).toThrow();
  });

  const session = {
    id: 9,
    user_id: 1,
    user_practice_id: 3,
    duration_minutes: 10,
    timestamp: '2026-03-01T10:30:00Z',
    reflection: null,
  };

  it('practiceSessionResponseSchema accepts valid and rejects a non-ISO timestamp', () => {
    expect(practiceSessionResponseSchema.parse(session).reflection).toBeNull();
    expect(() => practiceSessionResponseSchema.parse({ ...session, timestamp: 'oops' })).toThrow();
    expect(() =>
      practiceSessionResponseSchema.parse({ ...session, user_practice_id: undefined }),
    ).toThrow();
  });
});
