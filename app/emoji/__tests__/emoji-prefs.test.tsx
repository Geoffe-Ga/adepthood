/* eslint-env jest */
/* global describe, it, expect */
import { jest } from '@jest/globals';
import React from 'react';

import {
  EmojiPreferencesProvider,
  mergeRecents,
  useEmojiPreferences,
  type EmojiPreferencesContextValue,
} from '../emoji-prefs';

import TestRenderer, { act } from 'react-test-renderer';


jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    getItem: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    removeItem: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
  };
});

jest.mock('../../services/emojiApi', () => ({
  getEmojiPrefs: jest.fn(async () => ({ recents: [], preferred_skin_tone: null })),
  patchEmojiPrefs: jest.fn(async () => ({})),
}));

describe('mergeRecents', () => {
  it('deduplicates and caps length', () => {
    const result = mergeRecents(['b', 'c'], ['a', 'b'], 3);
    expect(result).toEqual(['a', 'b', 'c']);
    const capped = mergeRecents(['1', '2', '3'], ['4', '5'], 4);
    expect(capped).toEqual(['4', '5', '1', '2']);
  });
});

describe('EmojiPreferencesProvider', () => {
  it('pushRecent updates recents list', async () => {
    let ctx!: EmojiPreferencesContextValue;
    const Capture = () => {
      ctx = useEmojiPreferences();
      return null;
    };
    await act(async () => {
      TestRenderer.create(
        <EmojiPreferencesProvider>
          <Capture />
        </EmojiPreferencesProvider>,
      );
    });
    await act(async () => {
      await ctx.pushRecent('1f44d');
      await ctx.pushRecent('1f44e');
      await ctx.pushRecent('1f44d');
    });
    expect(ctx.recents).toEqual(['1f44d', '1f44e']);
  });

  it('clearRecents empties recents', async () => {
    let ctx!: EmojiPreferencesContextValue;
    const Capture = () => {
      ctx = useEmojiPreferences();
      return null;
    };
    await act(async () => {
      TestRenderer.create(
        <EmojiPreferencesProvider>
          <Capture />
        </EmojiPreferencesProvider>,
      );
    });
    await act(async () => {
      await ctx.pushRecent('1f44d');
      await ctx.clearRecents();
    });
    expect(ctx.recents).toEqual([]);
  });
});
