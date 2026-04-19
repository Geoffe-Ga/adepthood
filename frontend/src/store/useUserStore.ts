import { create } from 'zustand';

import { registerStoreReset } from './registry';

export interface UserPreferences {
  theme: 'light' | 'dark';
  notificationsEnabled: boolean;
}

export interface UserStoreState {
  preferences: UserPreferences;

  updatePreferences: (_prefs: Partial<UserPreferences>) => void;
  /** BUG-FE-STATE-001: wipe every field back to its initial value on logout. */
  reset: () => void;
}

const INITIAL_PREFERENCES: UserPreferences = {
  theme: 'light',
  notificationsEnabled: true,
};

export const useUserStore = create<UserStoreState>((set) => ({
  preferences: { ...INITIAL_PREFERENCES },

  updatePreferences: (prefs) =>
    set((state) => ({
      preferences: { ...state.preferences, ...prefs },
    })),
  reset: () => set({ preferences: { ...INITIAL_PREFERENCES } }),
}));

// BUG-FE-STATE-001
registerStoreReset(() => {
  useUserStore.getState().reset();
});
