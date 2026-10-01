import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: { get: jest.fn(), update: jest.fn() },
}));

import { resetAllStores } from '../registry';
import { usePracticeHabitLinkStore } from '../usePracticeHabitLinkStore';
import { useWritingHabitLinkStore } from '../useWritingHabitLinkStore';

import type { UiFlags, UiFlagsUpdate } from '@/api';

const mockUiFlags = (jest.requireMock('@/api') as { uiFlags: unknown }).uiFlags as {
  get: jest.Mock<(_token?: string) => Promise<UiFlags>>;
  update: jest.Mock<(_partial: UiFlagsUpdate, _token?: string) => Promise<UiFlags>>;
};

const TOKEN = 'link-tok';
const PRACTICE_HABIT_ID = 7;
const WRITING_HABIT_ID = 9;
const CHOSEN_HABIT_ID = 12;
const ECHOED_HABIT_ID = 13;

const flags = (practiceHabitId: number | null, writingHabitId: number | null = null): UiFlags => ({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  writing_session_habit_id: writingHabitId,
  practice_session_habit_id: practiceHabitId,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  usePracticeHabitLinkStore.getState().reset();
  useWritingHabitLinkStore.getState().reset();
});

describe('usePracticeHabitLinkStore.hydrate', () => {
  it('adopts the practice link the server holds, not the writing one', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID, WRITING_HABIT_ID));

    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    expect(mockUiFlags.get).toHaveBeenCalledWith(TOKEN);
    expect(usePracticeHabitLinkStore.getState().habitId).toBe(PRACTICE_HABIT_ID);
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('a payload from a server that predates the link reads as unlinked', async () => {
    mockUiFlags.get.mockResolvedValueOnce({
      has_seen_welcome: true,
      energy_scaffolding_archived: false,
      writing_session_habit_id: WRITING_HABIT_ID,
      practice_session_habit_id: null,
    });

    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    expect(usePracticeHabitLinkStore.getState().habitId).toBeNull();
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('a failed read leaves it unhydrated, so the next mount asks again', async () => {
    mockUiFlags.get.mockRejectedValueOnce(new Error('offline'));
    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(false);

    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID));
    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    expect(mockUiFlags.get).toHaveBeenCalledTimes(2);
    expect(usePracticeHabitLinkStore.getState().habitId).toBe(PRACTICE_HABIT_ID);
  });

  it('two hydrates in flight at once make one request', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID));

    await Promise.all([
      usePracticeHabitLinkStore.getState().hydrate(TOKEN),
      usePracticeHabitLinkStore.getState().hydrate(TOKEN),
    ]);

    expect(mockUiFlags.get).toHaveBeenCalledTimes(1);
  });

  it('is independent of the writing store: each hydrates on its own', async () => {
    mockUiFlags.get.mockResolvedValue(flags(PRACTICE_HABIT_ID, WRITING_HABIT_ID));

    await useWritingHabitLinkStore.getState().hydrate(TOKEN);
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(false);

    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    expect(useWritingHabitLinkStore.getState().habitId).toBe(WRITING_HABIT_ID);
    expect(usePracticeHabitLinkStore.getState().habitId).toBe(PRACTICE_HABIT_ID);
  });
});

describe('usePracticeHabitLinkStore.setLink', () => {
  it('PATCHes practice_session_habit_id and adopts the id the server echoes back', async () => {
    mockUiFlags.update.mockResolvedValueOnce(flags(ECHOED_HABIT_ID));

    const ok = await usePracticeHabitLinkStore.getState().setLink(CHOSEN_HABIT_ID, TOKEN);

    expect(ok).toBe(true);
    expect(mockUiFlags.update).toHaveBeenCalledWith(
      { practice_session_habit_id: CHOSEN_HABIT_ID },
      TOKEN,
    );
    expect(usePracticeHabitLinkStore.getState().habitId).toBe(ECHOED_HABIT_ID);
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('clearing sends an explicit null', async () => {
    mockUiFlags.update.mockResolvedValueOnce(flags(null));

    const ok = await usePracticeHabitLinkStore.getState().setLink(null, TOKEN);

    expect(ok).toBe(true);
    expect(mockUiFlags.update).toHaveBeenCalledWith({ practice_session_habit_id: null }, TOKEN);
    expect(usePracticeHabitLinkStore.getState().habitId).toBeNull();
  });

  it('a refused PATCH returns false and keeps the link it had', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID));
    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);
    mockUiFlags.update.mockRejectedValueOnce(new Error('403'));

    const ok = await usePracticeHabitLinkStore.getState().setLink(CHOSEN_HABIT_ID, TOKEN);

    expect(ok).toBe(false);
    expect(usePracticeHabitLinkStore.getState().habitId).toBe(PRACTICE_HABIT_ID);
  });
});

describe('usePracticeHabitLinkStore.forgetHabit', () => {
  it('forgets the link when the linked habit is deleted on this device', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID));
    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    usePracticeHabitLinkStore.getState().forgetHabit(PRACTICE_HABIT_ID);

    expect(usePracticeHabitLinkStore.getState().habitId).toBeNull();
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('keeps the link when some other habit is deleted', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID));
    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    usePracticeHabitLinkStore.getState().forgetHabit(CHOSEN_HABIT_ID);

    expect(usePracticeHabitLinkStore.getState().habitId).toBe(PRACTICE_HABIT_ID);
  });
});

describe('usePracticeHabitLinkStore.reset', () => {
  it('logging out forgets the link, through the store registry', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(PRACTICE_HABIT_ID));
    await usePracticeHabitLinkStore.getState().hydrate(TOKEN);

    resetAllStores();

    expect(usePracticeHabitLinkStore.getState().habitId).toBeNull();
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(false);
  });

  it('a read still in flight at logout never lands on the next account', async () => {
    let answer: ((value: UiFlags) => void) | undefined;
    mockUiFlags.get.mockImplementationOnce(
      () =>
        new Promise<UiFlags>((resolve) => {
          answer = resolve;
        }),
    );
    const previousAccount = usePracticeHabitLinkStore.getState().hydrate(TOKEN);
    await Promise.resolve();

    resetAllStores();
    answer?.(flags(PRACTICE_HABIT_ID));
    await previousAccount;

    expect(usePracticeHabitLinkStore.getState().habitId).toBeNull();
    expect(usePracticeHabitLinkStore.getState().hydrated).toBe(false);
  });
});
