import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CORPUS_SWEEP_OFFER_NEVER_KEY,
  loadCorpusSweepOfferDeclined,
  saveCorpusSweepOfferDeclined,
} from '../corpusSweepOfferStorage';
import { setActiveUser } from '../userScope';

/**
 * The journal page's "Do not ask again" on the offer to sort the rest of the
 * writing (#3500): kept per account on this device, and quiet whenever it
 * cannot be read, because the note it governs renders nothing on any error.
 */

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

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
  setActiveUser(1);
});

afterEach(() => {
  setActiveUser(null);
  jest.restoreAllMocks();
});

describe('corpusSweepOfferStorage', () => {
  test('keeps its own key, apart from the consent invitation and the Settings row', () => {
    expect(CORPUS_SWEEP_OFFER_NEVER_KEY).toBe('@adepthood/corpus_sweep_offer_never');
  });

  test('nothing stored reads as not declined', async () => {
    await expect(loadCorpusSweepOfferDeclined()).resolves.toBe(false);
  });

  test('a decline is written under the account and read back', async () => {
    await expect(saveCorpusSweepOfferDeclined()).resolves.toBe(true);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      `${CORPUS_SWEEP_OFFER_NEVER_KEY}#u1`,
      'true',
    );
    await expect(loadCorpusSweepOfferDeclined()).resolves.toBe(true);
  });

  test('one account never inherits another account’s decline', async () => {
    await saveCorpusSweepOfferDeclined();

    setActiveUser(2);

    await expect(loadCorpusSweepOfferDeclined()).resolves.toBe(false);
  });

  test.each(['false', 'yes', ''])('a stored %p is not a decline', async (raw) => {
    mockStore.set(`${CORPUS_SWEEP_OFFER_NEVER_KEY}#u1`, raw);

    await expect(loadCorpusSweepOfferDeclined()).resolves.toBe(false);
  });

  test('a read error stays quiet, because the note renders nothing on any error', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('storage error'));

    await expect(loadCorpusSweepOfferDeclined()).resolves.toBe(true);
    warn.mockRestore();
  });

  test('a failed write resolves false instead of rejecting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAsyncStorage.setItem.mockRejectedValueOnce(new Error('quota'));

    await expect(saveCorpusSweepOfferDeclined()).resolves.toBe(false);
    warn.mockRestore();
  });
});
