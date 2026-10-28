import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { loadReturnOfferDismissed, saveReturnOfferDismissed } from '../returnOfferStorage';

const mockRows = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (key: string) => mockRows.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string) => {
    mockRows.set(key, value);
  }),
}));

const A = { userId: 1, episode: 'opaque-first-offer' };
const B = { userId: 2, episode: 'opaque-first-offer' };
const NEXT = { userId: 1, episode: 'opaque-next-offer' };

beforeEach(() => {
  mockRows.clear();
  jest.clearAllMocks();
});

describe('Return account and opaque episode ownership', () => {
  it('keeps the same account/episode choice without assigning it to B or the next episode', async () => {
    await saveReturnOfferDismissed(A, true);
    expect(await loadReturnOfferDismissed(A)).toBe(true);
    expect(await loadReturnOfferDismissed(B)).toBe(false);
    expect(await loadReturnOfferDismissed(NEXT)).toBe(false);
    await saveReturnOfferDismissed(B, true);
    await saveReturnOfferDismissed(A, false);
    expect(await loadReturnOfferDismissed(A)).toBe(false);
    expect(await loadReturnOfferDismissed(B)).toBe(true);
  });

  it('retains an unknown old global boolean without treating it as the current offer answer', async () => {
    mockRows.set('@adepthood/return_offer_dismissed', 'true');
    expect(await loadReturnOfferDismissed(A)).toBe(false);
    expect(await loadReturnOfferDismissed(B)).toBe(false);
    expect(mockRows.get('@adepthood/return_offer_dismissed')).toBe('true');
  });

  it('captures both identity fields before a delayed write can outlive its caller', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
      await held;
      mockRows.set(key, value);
    });
    const identity = { ...A };
    const saving = saveReturnOfferDismissed(identity, true);
    identity.userId = B.userId;
    identity.episode = NEXT.episode;
    release();
    await saving;
    expect(await loadReturnOfferDismissed(A)).toBe(true);
    expect(await loadReturnOfferDismissed(identity)).toBe(false);
  });
});
