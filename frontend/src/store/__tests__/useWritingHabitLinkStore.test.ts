import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: { get: jest.fn(), update: jest.fn() },
}));

import { resetAllStores } from '../registry';
import { useWritingHabitLinkStore } from '../useWritingHabitLinkStore';

import type { UiFlags, UiFlagsUpdate } from '@/api';

const mockUiFlags = (jest.requireMock('@/api') as { uiFlags: unknown }).uiFlags as {
  get: jest.Mock<(_token?: string) => Promise<UiFlags>>;
  update: jest.Mock<(_partial: UiFlagsUpdate, _token?: string) => Promise<UiFlags>>;
};

const TOKEN = 'link-tok';
const SERVER_HABIT_ID = 7;
const CHOSEN_HABIT_ID = 12;
const ECHOED_HABIT_ID = 13;

const flags = (habitId: number | null): UiFlags => ({
  has_seen_welcome: true,
  energy_scaffolding_archived: false,
  writing_session_habit_id: habitId,
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  useWritingHabitLinkStore.getState().reset();
});

describe('useWritingHabitLinkStore.hydrate', () => {
  it('adopts the id the server holds and marks itself hydrated', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));

    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    expect(mockUiFlags.get).toHaveBeenCalledWith(TOKEN);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(SERVER_HABIT_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('a failed read leaves it unhydrated, so the next mount asks again', async () => {
    mockUiFlags.get.mockRejectedValueOnce(new Error('offline'));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();

    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    expect(mockUiFlags.get).toHaveBeenCalledTimes(2);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(SERVER_HABIT_ID);
  });

  it('a client that throws synchronously is caught, never thrown at the page', async () => {
    mockUiFlags.get.mockImplementationOnce(() => {
      throw new TypeError('uiFlags is not configured');
    });

    await expect(useWritingHabitLinkStore.getState().hydrate(TOKEN)).resolves.toBeUndefined();

    expect(useWritingHabitLinkStore.getState().hydrated).toBe(false);
  });

  it('two hydrates in flight at once make one request', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));

    await Promise.all([
      useWritingHabitLinkStore.getState().hydrate(TOKEN),
      useWritingHabitLinkStore.getState().hydrate(TOKEN),
    ]);

    expect(mockUiFlags.get).toHaveBeenCalledTimes(1);
  });

  it('once hydrated, a later hydrate asks nothing', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(null));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    expect(mockUiFlags.get).toHaveBeenCalledTimes(1);
  });
});

describe('useWritingHabitLinkStore.forgetHabit', () => {
  it('forgets the link when the linked habit is deleted on this device', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    useWritingHabitLinkStore.getState().forgetHabit(SERVER_HABIT_ID);

    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('keeps the link when some other habit is deleted', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    useWritingHabitLinkStore.getState().forgetHabit(CHOSEN_HABIT_ID);

    expect(useWritingHabitLinkStore.getState().habitId).toBe(SERVER_HABIT_ID);
  });
});

describe('useWritingHabitLinkStore.setLink', () => {
  it('PATCHes the id and adopts the id the server echoes back', async () => {
    mockUiFlags.update.mockResolvedValueOnce(flags(ECHOED_HABIT_ID));

    const ok = await useWritingHabitLinkStore.getState().setLink(CHOSEN_HABIT_ID, TOKEN);

    expect(ok).toBe(true);
    expect(mockUiFlags.update).toHaveBeenCalledWith(
      { writing_session_habit_id: CHOSEN_HABIT_ID },
      TOKEN,
    );
    expect(useWritingHabitLinkStore.getState().habitId).toBe(ECHOED_HABIT_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('clearing sends an explicit null', async () => {
    mockUiFlags.update.mockResolvedValueOnce(flags(null));

    const ok = await useWritingHabitLinkStore.getState().setLink(null, TOKEN);

    expect(ok).toBe(true);
    expect(mockUiFlags.update).toHaveBeenCalledWith({ writing_session_habit_id: null }, TOKEN);
    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
  });

  it('a refused PATCH returns false and keeps the link it had', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);
    mockUiFlags.update.mockRejectedValueOnce(new Error('403'));

    const ok = await useWritingHabitLinkStore.getState().setLink(CHOSEN_HABIT_ID, TOKEN);

    expect(ok).toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(SERVER_HABIT_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });
});

describe('useWritingHabitLinkStore.reset', () => {
  it('a read still in flight at logout never lands on the next account', async () => {
    let answer: ((value: UiFlags) => void) | undefined;
    mockUiFlags.get.mockImplementationOnce(
      () =>
        new Promise<UiFlags>((resolve) => {
          answer = resolve;
        }),
    );
    const previousAccount = useWritingHabitLinkStore.getState().hydrate(TOKEN);
    await Promise.resolve();

    resetAllStores();
    answer?.(flags(SERVER_HABIT_ID));
    await previousAccount;

    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(false);
  });

  it('after logout, the next account reads its own link rather than joining the old read', async () => {
    mockUiFlags.get.mockImplementationOnce(() => new Promise<UiFlags>(() => undefined));
    void useWritingHabitLinkStore.getState().hydrate('old-tok');
    await Promise.resolve();
    resetAllStores();
    mockUiFlags.get.mockResolvedValueOnce(flags(CHOSEN_HABIT_ID));

    await useWritingHabitLinkStore.getState().hydrate('new-tok');

    expect(mockUiFlags.get).toHaveBeenLastCalledWith('new-tok');
    expect(useWritingHabitLinkStore.getState().habitId).toBe(CHOSEN_HABIT_ID);
  });

  it('logging out forgets the link', async () => {
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate(TOKEN);

    resetAllStores();

    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(false);
  });
});
