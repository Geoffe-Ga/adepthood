import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LINK_HABIT_NUDGE_NEVER_OFFER_KEY,
  loadLinkHabitNudgeDeclined,
  restoreLinkHabitNudge,
  saveLinkHabitNudgeDeclined,
} from '../linkHabitNudgeStorage';

/** An in-memory AsyncStorage, so a test can read back what an earlier call wrote. */
const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn((key: string, value: string) => {
    mockStore.set(key, value);
    return Promise.resolve();
  }),
  getItem: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
}));

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

/** The neighbouring device flags this one must never share a key with. */
const WRITING_OFFER_ANSWERED_KEY = '@adepthood/writing_habit_offer_answered';
const MORNING_PAGES_KEYS = [
  '@adepthood/morning_pages_tip_dismissed',
  '@adepthood/morning_pages_tip_set_aside_on',
  '@adepthood/morning_pages_tip_never_offer',
];

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('linkHabitNudgeStorage', () => {
  test('keeps its own key, apart from the offer and the morning-pages tip', () => {
    expect(LINK_HABIT_NUDGE_NEVER_OFFER_KEY).toBe('@adepthood/link_habit_nudge_never_offer');
    expect(LINK_HABIT_NUDGE_NEVER_OFFER_KEY).not.toBe(WRITING_OFFER_ANSWERED_KEY);
    expect(MORNING_PAGES_KEYS).not.toContain(LINK_HABIT_NUDGE_NEVER_OFFER_KEY);
  });

  test('empty storage reads as not declined, so the note is shown', async () => {
    await expect(loadLinkHabitNudgeDeclined()).resolves.toBe(false);
  });

  test('a decline is written under its key, read back, and resolves that it saved', async () => {
    await expect(saveLinkHabitNudgeDeclined()).resolves.toBe(true);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(LINK_HABIT_NUDGE_NEVER_OFFER_KEY, 'true');
    await expect(loadLinkHabitNudgeDeclined()).resolves.toBe(true);
  });

  test.each(['false', 'yes', ''])('a stored %p is not a decline', async (raw) => {
    mockStore.set(LINK_HABIT_NUDGE_NEVER_OFFER_KEY, raw);

    await expect(loadLinkHabitNudgeDeclined()).resolves.toBe(false);
  });

  test('a read error fails open, so the note is shown, and says so', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('storage error');
    mockAsyncStorage.getItem.mockRejectedValueOnce(error);

    await expect(loadLinkHabitNudgeDeclined()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[linkHabitNudgeStorage] failed to load the decline', error);
  });

  test('a failed decline write resolves false and says so rather than rejecting', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('quota exceeded');
    mockAsyncStorage.setItem.mockRejectedValueOnce(error);

    await expect(saveLinkHabitNudgeDeclined()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[linkHabitNudgeStorage] failed to save the decline', error);
  });

  test('restore clears the decline and resolves true', async () => {
    await saveLinkHabitNudgeDeclined();
    jest.clearAllMocks();

    await expect(restoreLinkHabitNudge()).resolves.toBe(true);

    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      LINK_HABIT_NUDGE_NEVER_OFFER_KEY,
      'false',
    );
    await expect(loadLinkHabitNudgeDeclined()).resolves.toBe(false);
  });

  test('a failed restore resolves false and says so, so Settings does not claim it worked', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('storage blocked');
    mockAsyncStorage.setItem.mockRejectedValueOnce(error);

    await expect(restoreLinkHabitNudge()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('[linkHabitNudgeStorage] failed to restore the note', error);
  });
});
