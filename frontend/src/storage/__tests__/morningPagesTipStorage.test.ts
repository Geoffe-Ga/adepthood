import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  MORNING_PAGES_TIP_OPEN,
  loadMorningPagesTipState,
  restoreMorningPagesTip,
  saveMorningPagesTipNeverOffer,
  saveMorningPagesTipSetAside,
} from '../morningPagesTipStorage';

/** An in-memory AsyncStorage, so a test can read back what an earlier call wrote. */
const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn((key: string, value: string) => {
    mockStore.set(key, value);
    return Promise.resolve();
  }),
  getItem: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
  removeItem: jest.fn((key: string) => {
    mockStore.delete(key);
    return Promise.resolve();
  }),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const LEGACY_KEY = '@adepthood/morning_pages_tip_dismissed';
const SET_ASIDE_ON_KEY = '@adepthood/morning_pages_tip_set_aside_on';
const NEVER_OFFER_KEY = '@adepthood/morning_pages_tip_never_offer';

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('morningPagesTipStorage', () => {
  test('empty storage reads as the open state: offered, not set aside', async () => {
    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: null,
      neverOffer: false,
    });
    expect(MORNING_PAGES_TIP_OPEN).toEqual({ setAsideOn: null, neverOffer: false });
  });

  test('setting the tip aside stores the day it was set aside on, under its own key', async () => {
    await saveMorningPagesTipSetAside('2026-09-10');

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(SET_ASIDE_ON_KEY, '2026-09-10');
    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: '2026-09-10',
      neverOffer: false,
    });
  });

  test.each([true, false])('the never-offer flag round-trips %s', async (value) => {
    await saveMorningPagesTipNeverOffer(value);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(NEVER_OFFER_KEY, String(value));
    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: null,
      neverOffer: value,
    });
  });

  test("a legacy 'true' dismissal migrates to the permanent never-offer flag", async () => {
    mockStore.set(LEGACY_KEY, 'true');

    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: null,
      neverOffer: true,
    });

    // Write the new flag FIRST, then drop the legacy one: a crash between the
    // two must leave the writer still declined, never silently re-offered.
    expect(mockAsyncStorage.setItem).toHaveBeenCalledTimes(1);
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(NEVER_OFFER_KEY, 'true');
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledTimes(1);
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(LEGACY_KEY);
    const [writeOrder] = mockAsyncStorage.setItem.mock.invocationCallOrder;
    const [removeOrder] = mockAsyncStorage.removeItem.mock.invocationCallOrder;
    expect(writeOrder).toBeLessThan(removeOrder as number);
    expect(mockStore.has(LEGACY_KEY)).toBe(false);

    // Once only: the second read finds nothing left to migrate.
    jest.clearAllMocks();
    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: null,
      neverOffer: true,
    });
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
  });

  test.each(['false', 'yes', ''])(
    'a legacy %p is ignored and left alone: the tip is offered, nothing is written',
    async (legacy) => {
      mockStore.set(LEGACY_KEY, legacy);

      await expect(loadMorningPagesTipState()).resolves.toEqual(MORNING_PAGES_TIP_OPEN);
      expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
      expect(mockAsyncStorage.removeItem).not.toHaveBeenCalled();
      expect(mockStore.get(LEGACY_KEY)).toBe(legacy);
    },
  );

  test('a read error fails open, so the tip is offered, and says so', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('storage error');
    mockAsyncStorage.getItem.mockRejectedValueOnce(error);

    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: null,
      neverOffer: false,
    });
    expect(warn).toHaveBeenCalledWith(
      '[morningPagesTipStorage] failed to load dismissal state',
      error,
    );
  });

  test('restore clears both the permanent flag and today’s set-aside, so the tip is back now', async () => {
    await saveMorningPagesTipSetAside('2026-09-10');
    await saveMorningPagesTipNeverOffer(true);
    jest.clearAllMocks();

    await restoreMorningPagesTip();

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(NEVER_OFFER_KEY, 'false');
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith(SET_ASIDE_ON_KEY);
    await expect(loadMorningPagesTipState()).resolves.toEqual({
      setAsideOn: null,
      neverOffer: false,
    });
  });

  test('restore before the first shelf read is not undone by the legacy migration', async () => {
    // A writer who declined under the old single flag opens Settings from
    // another tab and restores before the Journal shelf has ever loaded.
    mockStore.set(LEGACY_KEY, 'true');

    await expect(restoreMorningPagesTip()).resolves.toBe(true);

    expect(mockStore.has(LEGACY_KEY)).toBe(false);
    await expect(loadMorningPagesTipState()).resolves.toEqual(MORNING_PAGES_TIP_OPEN);
  });

  test.each([
    ['set aside', () => saveMorningPagesTipSetAside('2026-09-10')],
    ['never offer', () => saveMorningPagesTipNeverOffer(true)],
  ])('a failed %s write resolves and says so rather than rejecting', async (_label, write) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('quota exceeded');
    mockAsyncStorage.setItem.mockRejectedValueOnce(error);

    await expect(write()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      '[morningPagesTipStorage] failed to save dismissal state',
      error,
    );
  });

  test('an interruption after any one of restore’s writes never re-locks the tip', async () => {
    // A writer who still has the legacy decline presses restore, and the app is
    // killed after the first write lands. Whatever got written, the next read
    // must not carry the old decline over and silently undo the restore.
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStore.set(LEGACY_KEY, 'true');
    let restoring = true;
    let writes = 0;
    const interruptAfterFirstWrite = () => {
      if (!restoring) return false;
      writes += 1;
      return writes > 1;
    };
    mockAsyncStorage.setItem.mockImplementation((key: string, value: string) => {
      if (interruptAfterFirstWrite()) return Promise.reject(new Error('killed'));
      mockStore.set(key, value);
      return Promise.resolve();
    });
    mockAsyncStorage.removeItem.mockImplementation((key: string) => {
      if (interruptAfterFirstWrite()) return Promise.reject(new Error('killed'));
      mockStore.delete(key);
      return Promise.resolve();
    });

    await expect(restoreMorningPagesTip()).resolves.toBe(false);
    // The app comes back up: storage works again, and the shelf reads.
    restoring = false;

    await expect(loadMorningPagesTipState()).resolves.toEqual(MORNING_PAGES_TIP_OPEN);
    expect(mockStore.get(NEVER_OFFER_KEY)).not.toBe('true');
  });

  test('a failed restore resolves false and says so, so Settings does not claim it worked', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('storage blocked');
    mockAsyncStorage.setItem.mockRejectedValueOnce(error);

    await expect(restoreMorningPagesTip()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[morningPagesTipStorage] failed to restore the tip', error);
  });
});
