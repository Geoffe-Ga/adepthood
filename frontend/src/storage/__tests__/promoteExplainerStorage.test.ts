/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  loadPromoteExplainerDismissed,
  savePromoteExplainerDismissed,
} from '../promoteExplainerStorage';
import { setActiveUser } from '../userScope';

/**
 * The dismissal flag for the promote-a-quote explainer (#2864).
 *
 * Scoped per account: one reader's "I know where promoted quotes go" must not
 * answer for the next account on the device, who has never been told.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

const KEY_BASE = '@adepthood/promote_explainer_dismissed';

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

describe('loadPromoteExplainerDismissed', () => {
  test('is false when nothing has been stored, so the explainer shows', async () => {
    expect(await loadPromoteExplainerDismissed()).toBe(false);
  });

  test('round-trips a dismissal', async () => {
    await savePromoteExplainerDismissed(true);

    expect(await loadPromoteExplainerDismissed()).toBe(true);
  });

  test('a cleared dismissal brings the explainer back', async () => {
    await savePromoteExplainerDismissed(true);
    await savePromoteExplainerDismissed(false);

    expect(await loadPromoteExplainerDismissed()).toBe(false);
  });

  test('a read failure resolves false rather than suppressing the explainer', async () => {
    mockAsyncStorage.getItem.mockRejectedValueOnce(new Error('disk'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await loadPromoteExplainerDismissed()).toBe(false);

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the flag is namespaced per account (BUG-FE-STATE-001)', () => {
  test('one account’s dismissal never answers for the next account on the device', async () => {
    setActiveUser(1);
    await savePromoteExplainerDismissed(true);

    setActiveUser(2);

    // The incoming account has never been told where a promoted quote goes.
    expect(await loadPromoteExplainerDismissed()).toBe(false);
  });

  test('the original account still finds its own dismissal on return', async () => {
    setActiveUser(1);
    await savePromoteExplainerDismissed(true);
    setActiveUser(2);
    await savePromoteExplainerDismissed(false);

    setActiveUser(1);

    expect(await loadPromoteExplainerDismissed()).toBe(true);
  });

  test('writes land under the account-suffixed key, not the bare one', async () => {
    setActiveUser(7);
    await savePromoteExplainerDismissed(true);

    expect(store[`${KEY_BASE}#u7`]).toBe('true');
    expect(store[KEY_BASE]).toBeUndefined();
  });
});
