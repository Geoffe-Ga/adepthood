import { create } from 'zustand';

export interface UserPreferences {
  theme: 'light' | 'dark';
  notificationsEnabled: boolean;
}

/* eslint-disable no-unused-vars */
export interface UserStoreState {
  preferences: UserPreferences;

  updatePreferences: (_prefs: Partial<UserPreferences>) => void;
}
/* eslint-enable no-unused-vars */

export const useUserStore = create<UserStoreState>((set) => ({
  preferences: {
    theme: 'light',
    notificationsEnabled: true,
  },

  updatePreferences: (prefs) =>
    set((state) => ({
      preferences: { ...state.preferences, ...prefs },
    })),
}));
