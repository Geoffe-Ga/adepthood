import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { JOURNAL_HABIT_DEFAULT_GOALS, writingGoalDraft } from '../journalHabitDefaults';
import { saveWritingHabitGoals } from '../writingHabitGoals';

import { goals, habits, setTokenGetter } from '@/api';
import type * as ApiModule from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { useHabitStore } from '@/store/useHabitStore';

jest.mock('@/api', () => ({
  ...jest.requireActual<typeof ApiModule>('@/api'),
  habits: { updateGoalUnits: jest.fn(), listAll: jest.fn() },
  goals: { update: jest.fn() },
}));

const original = () => ({
  ...writingGoalDraft(),
  id: 42,
  goals: writingGoalDraft().goals.map((goal, index) => ({
    ...goal,
    id: 101 + index,
    target_unit: 'pages',
  })),
});

const ownerToken = `e30.${btoa(JSON.stringify({ sub: '1', exp: 4_000_000_000 }))}.sig`;

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  setTokenGetter(() => ownerToken);
  useHabitStore.setState({ habits: [original()] });
  jest.mocked(habits.updateGoalUnits).mockResolvedValue([]);
  jest.mocked(goals.update).mockResolvedValue({} as Awaited<ReturnType<typeof goals.update>>);
  jest
    .mocked(habits.listAll)
    .mockResolvedValue([{ ...writingGoalDraft(original()), start_date: '2026-01-01' }] as Awaited<
      ReturnType<typeof habits.listAll>
    >);
});

afterEach(() => {
  jest.restoreAllMocks();
  setActiveUser(null);
  setTokenGetter(null);
});

describe('confirmed goal setup before linking a timer', () => {
  it('writes shared units then every tier, and returns only the fresh server ladder', async () => {
    const result = await saveWritingHabitGoals(
      original(),
      JOURNAL_HABIT_DEFAULT_GOALS,
      'UTC',
      ownerToken,
    );
    expect(habits.updateGoalUnits).toHaveBeenCalledWith(
      42,
      {
        target_unit: 'minutes',
        frequency: 1,
        frequency_unit: 'per_day',
      },
      ownerToken,
    );
    expect(
      jest.mocked(goals.update).mock.calls.map(([id, payload]) => [id, payload.target]),
    ).toEqual([
      [101, 10],
      [102, 20],
      [103, 45],
    ]);
    expect(result?.goals[0]?.target_unit).toBe('minutes');
  });
  it('does not claim a completed setup when one tier fails', async () => {
    jest.mocked(goals.update).mockRejectedValueOnce(new Error('offline'));
    await expect(
      saveWritingHabitGoals(original(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', ownerToken),
    ).rejects.toThrow();
    expect(goals.update).toHaveBeenCalledTimes(1);
  });
  it('does not confirm a stale or unreadable server ladder', async () => {
    jest.mocked(habits.listAll).mockRejectedValueOnce(new Error('confirmation unavailable'));
    await expect(
      saveWritingHabitGoals(original(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', ownerToken),
    ).rejects.toThrow();
  });
  it('stops after an owner change and never writes the next tier as the incoming user', async () => {
    jest.mocked(habits.updateGoalUnits).mockImplementationOnce(async () => {
      setActiveUser(2);
      return [];
    });
    await expect(
      saveWritingHabitGoals(original(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', ownerToken),
    ).resolves.toBeNull();
    expect(goals.update).not.toHaveBeenCalled();
  });
  it('does not revive an old setup when the account changes away and back', async () => {
    jest.mocked(habits.updateGoalUnits).mockImplementationOnce(async () => {
      setActiveUser(2);
      setActiveUser(1);
      return [];
    });
    await expect(
      saveWritingHabitGoals(original(), JOURNAL_HABIT_DEFAULT_GOALS, 'UTC', ownerToken),
    ).resolves.toBeNull();
    expect(goals.update).not.toHaveBeenCalled();
    expect(habits.listAll).not.toHaveBeenCalled();
  });
});
