import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useContext, useEffect, useState } from 'react';

import { getEmojiPrefs, patchEmojiPrefs } from '../services/emojiApi';

export const RECENTS_KEY = 'emoji.recents.v1';
export const SKIN_KEY = 'emoji.skin.v1';

export interface EmojiPreferencesContextValue {
  recents: string[];
  preferredSkinTone?: number;
  pushRecent: (_unified: string) => Promise<void>;
  setPreferredSkinTone: (_tone: number) => Promise<void>;
  clearRecents: () => Promise<void>;
}

const EmojiPreferencesContext = createContext<EmojiPreferencesContextValue | undefined>(undefined);

/**
 * Merge new recents into existing list, removing duplicates and capping length.
 * New items appear first.
 */
export function mergeRecents(existing: string[], additions: string[], max: number = 32): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const code of [...additions, ...existing]) {
    if (!seen.has(code)) {
      merged.push(code);
      seen.add(code);
    }
    if (merged.length >= max) {
      break;
    }
  }
  return merged;
}

export const EmojiPreferencesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [recents, setRecents] = useState<string[]>([]);
  const [preferredSkinTone, setPreferredSkinToneState] = useState<number | undefined>();

  // Hydrate from storage and server on mount
  useEffect(() => {
    let mounted = true;
    const hydrate = async () => {
      try {
        const [storedRecents, storedTone] = await Promise.all([
          AsyncStorage.getItem(RECENTS_KEY),
          AsyncStorage.getItem(SKIN_KEY),
        ]);

        let localRecents: string[] = [];
        if (storedRecents) {
          localRecents = JSON.parse(storedRecents);
          if (mounted) setRecents(localRecents);
        }
        if (storedTone) {
          const tone = Number(storedTone);
          if (mounted) setPreferredSkinToneState(tone);
        }

        const server = await getEmojiPrefs();
        if (server.recents) {
          const merged = mergeRecents(localRecents, server.recents);
          if (mounted) setRecents(merged);
          await AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(merged));
          localRecents = merged;
        }
        if (server.preferred_skin_tone != null) {
          if (mounted) setPreferredSkinToneState(server.preferred_skin_tone);
          await AsyncStorage.setItem(SKIN_KEY, String(server.preferred_skin_tone));
        }
      } catch (error) {
        console.error('Failed to hydrate emoji prefs', error);
      }
    };
    hydrate();
    return () => {
      mounted = false;
    };
  }, []);

  const pushRecent = async (unified: string) => {
    setRecents((current) => {
      const merged = mergeRecents(current, [unified]);
      AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(merged)).catch(() => {});
      patchEmojiPrefs({
        preferred_skin_tone: preferredSkinTone,
        recents: merged,
      }).catch(() => {});
      return merged;
    });
  };

  const setPreferredSkinTone = async (tone: number) => {
    setPreferredSkinToneState(tone);
    AsyncStorage.setItem(SKIN_KEY, String(tone)).catch(() => {});
    patchEmojiPrefs({ preferred_skin_tone: tone, recents }).catch(() => {});
  };

  const clearRecents = async () => {
    setRecents([]);
    AsyncStorage.removeItem(RECENTS_KEY).catch(() => {});
    patchEmojiPrefs({ preferred_skin_tone: preferredSkinTone, recents: [] }).catch(() => {});
  };

  return (
    <EmojiPreferencesContext.Provider
      value={{
        recents,
        preferredSkinTone,
        pushRecent,
        setPreferredSkinTone,
        clearRecents,
      }}
    >
      {children}
    </EmojiPreferencesContext.Provider>
  );
};

export const useEmojiPreferences = () => {
  const ctx = useContext(EmojiPreferencesContext);
  if (!ctx) {
    throw new Error('useEmojiPreferences must be used within EmojiPreferencesProvider');
  }
  return ctx;
};
