/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadResonanceExplainerDismissed,
  saveResonanceExplainerDismissed,
} from '../resonanceExplainerStorage';
import { setActiveUser } from '../userScope';

/**
 * The dismissal flag for the resonance spend disclosure.
 *
 * The scoping assertions below are the point of this file, not decoration. The
 * flag suppresses the one screen that says a resonance pass spends money, so an
 * unscoped flag would let one account's "I know what this costs" answer for the
 * next account to hold the device — who would then be charged, against their
 * own allowance or their own API key, having been told nothing.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const KEY_BASE = '@adepthood/resonance_explainer_dismissed';

/** A store the tests own outright, so no assertion depends on mock-reset order. */
let store: Record<string, string>;

beforeEach(() => {
  jest.clearAllMocks();
  store = {};
  mockAsyncStorage.setItem.mockImplementation((key: string, value: string) => {
    store[key] = value;
    return Promise.resolve();
  });
  mockAsyncStorage.getItem.mockImplementation((key: string) => Promise.resolve(store[key] ?? null));
  setActiveUser(null);
});

describe('loadResonanceExplainerDismissed', () => {
  test('is false when nothing has been stored, so the disclosure shows', async () => {
    expect(await loadResonanceExplainerDismissed()).toBe(false);
  });

  test('round-trips a dismissal', async () => {
    await saveResonanceExplainerDismissed(true);

    expect(await loadResonanceExplainerDismissed()).toBe(true);
  });

  test('a cleared dismissal brings the disclosure back', async () => {
    await saveResonanceExplainerDismissed(true);
    await saveResonanceExplainerDismissed(false);

    expect(await loadResonanceExplainerDismissed()).toBe(false);
  });

  test('a read failure resolves false rather than suppressing the disclosure', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('disk'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await loadResonanceExplainerDismissed()).toBe(false);

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the flag is namespaced per account (BUG-FE-STATE-001)', () => {
  test('one account’s dismissal never answers for the next account on the device', async () => {
    setActiveUser(1);
    await saveResonanceExplainerDismissed(true);

    setActiveUser(2);

    // The incoming account has never been told what a pass costs, so it must
    // still be told — a charge landing on their allowance is theirs, not user 1's.
    expect(await loadResonanceExplainerDismissed()).toBe(false);
  });

  test('the original account still finds its own dismissal on return', async () => {
    setActiveUser(1);
    await saveResonanceExplainerDismissed(true);
    setActiveUser(2);
    await saveResonanceExplainerDismissed(false);

    setActiveUser(1);

    expect(await loadResonanceExplainerDismissed()).toBe(true);
  });

  test('writes land under the account-suffixed key, not the bare one', async () => {
    setActiveUser(7);
    await saveResonanceExplainerDismissed(true);

    expect(store[`${KEY_BASE}#u7`]).toBe('true');
    expect(store[KEY_BASE]).toBeUndefined();
  });
});
