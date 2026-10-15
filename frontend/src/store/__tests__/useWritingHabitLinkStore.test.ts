import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/api', () => ({
  __esModule: true,
  uiFlags: { get: jest.fn(), update: jest.fn() },
}));

import { resetAllStores } from '../registry';
import {
  getWritingHabitLinkGeneration,
  selectKnownUnlinked,
  useWritingHabitLinkStore,
} from '../useWritingHabitLinkStore';

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
  course_last_stage: null,
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

/**
 * A PATCH the test answers by hand, so an account change can land while it is
 * still on the wire (#3378).
 */
function deferUpdate(): (value: UiFlags) => void {
  let answer: ((value: UiFlags) => void) | undefined;
  mockUiFlags.update.mockImplementationOnce(
    () =>
      new Promise<UiFlags>((resolve) => {
        answer = resolve;
      }),
  );
  return (value) => answer?.(value);
}

const OUTGOING_HABIT_ID = 41;
const INCOMING_HABIT_ID = 52;
const INCOMING_CHOICE_ID = 63;

describe('useWritingHabitLinkStore.setLink across account changes (#3378)', () => {
  it('a PATCH that lands for the account still signed in is adopted', async () => {
    const answer = deferUpdate();
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');

    answer(flags(OUTGOING_HABIT_ID));

    await expect(pending).resolves.toBe(true);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(OUTGOING_HABIT_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('two picks by the same account both land, the later answer winning', async () => {
    const answerFirst = deferUpdate();
    const answerSecond = deferUpdate();
    const first = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');
    const second = useWritingHabitLinkStore.getState().setLink(SERVER_HABIT_ID, 'tok-a');

    answerFirst(flags(OUTGOING_HABIT_ID));
    await first;
    answerSecond(flags(SERVER_HABIT_ID));

    await expect(second).resolves.toBe(true);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(SERVER_HABIT_ID);
  });

  it('a PATCH that lands after logout leaves the store signed-out and unhydrated', async () => {
    const answer = deferUpdate();
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');

    resetAllStores();
    answer(flags(OUTGOING_HABIT_ID));

    await expect(pending).resolves.toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(false);
  });

  it("a PATCH that lands after an A→B switch cannot replace B's hydrated link", async () => {
    const answer = deferUpdate();
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');
    resetAllStores();
    mockUiFlags.get.mockResolvedValueOnce(flags(INCOMING_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate('tok-b');
    const generationBefore = getWritingHabitLinkGeneration();

    answer(flags(OUTGOING_HABIT_ID));

    await expect(pending).resolves.toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(INCOMING_HABIT_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
    // The stale answer must not look like a link change to the completion fence.
    expect(getWritingHabitLinkGeneration()).toBe(generationBefore);
  });

  it("a PATCH that lands after an A→B switch does not erase B's own selection", async () => {
    const answer = deferUpdate();
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');
    resetAllStores();
    mockUiFlags.update.mockResolvedValueOnce(flags(INCOMING_CHOICE_ID));
    await expect(
      useWritingHabitLinkStore.getState().setLink(INCOMING_CHOICE_ID, 'tok-b'),
    ).resolves.toBe(true);

    answer(flags(OUTGOING_HABIT_ID));

    await expect(pending).resolves.toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(INCOMING_CHOICE_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('a PATCH that lands before B has read anything leaves B free to read its own link', async () => {
    const answer = deferUpdate();
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');
    resetAllStores();

    answer(flags(OUTGOING_HABIT_ID));
    await pending;
    mockUiFlags.get.mockResolvedValueOnce(flags(INCOMING_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate('tok-b');

    expect(mockUiFlags.get).toHaveBeenCalledWith('tok-b');
    expect(useWritingHabitLinkStore.getState().habitId).toBe(INCOMING_HABIT_ID);
  });

  it('a PATCH from the first A session cannot land after A→B→A', async () => {
    const answer = deferUpdate();
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a1');
    resetAllStores();
    resetAllStores();
    mockUiFlags.get.mockResolvedValueOnce(flags(SERVER_HABIT_ID));
    await useWritingHabitLinkStore.getState().hydrate('tok-a2');

    answer(flags(OUTGOING_HABIT_ID));

    await expect(pending).resolves.toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBe(SERVER_HABIT_ID);
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(true);
  });

  it('a refused PATCH after logout changes nothing', async () => {
    let refuse: ((reason: Error) => void) | undefined;
    mockUiFlags.update.mockImplementationOnce(
      () =>
        new Promise<UiFlags>((_resolve, reject) => {
          refuse = reject;
        }),
    );
    const pending = useWritingHabitLinkStore.getState().setLink(OUTGOING_HABIT_ID, 'tok-a');
    resetAllStores();

    refuse?.(new Error('401'));

    await expect(pending).resolves.toBe(false);
    expect(useWritingHabitLinkStore.getState().habitId).toBeNull();
    expect(useWritingHabitLinkStore.getState().hydrated).toBe(false);
  });
});

describe('selectKnownUnlinked (#3006)', () => {
  const state = (habitId: number | null, hydrated: boolean) => ({
    ...useWritingHabitLinkStore.getState(),
    habitId,
    hydrated,
  });

  it('is true only when the server has answered "nothing linked"', () => {
    expect(selectKnownUnlinked(state(null, true))).toBe(true);
  });

  it('is false while unhydrated: the null default is not an answer', () => {
    expect(selectKnownUnlinked(state(null, false))).toBe(false);
  });

  it('is false when a habit is linked', () => {
    expect(selectKnownUnlinked(state(SERVER_HABIT_ID, true))).toBe(false);
  });
});
