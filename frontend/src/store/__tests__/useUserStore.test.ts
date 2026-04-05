import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

describe('useUserStore', () => {
  beforeEach(() => {
    const { useUserStore } = require('../useUserStore');
    useUserStore.setState({
      preferences: { theme: 'light', notificationsEnabled: true },
    });
  });

  it('has correct initial state', () => {
    jest.resetModules();
    const { useUserStore } = require('../useUserStore');
    const state = useUserStore.getState();

    expect(state.preferences).toEqual({
      theme: 'light',
      notificationsEnabled: true,
    });
  });

  it('updatePreferences merges new values into existing preferences', () => {
    const { useUserStore } = require('../useUserStore');

    act(() => useUserStore.getState().updatePreferences({ theme: 'dark' }));

    expect(useUserStore.getState().preferences).toEqual({
      theme: 'dark',
      notificationsEnabled: true,
    });
  });

  it('updatePreferences can toggle notifications', () => {
    const { useUserStore } = require('../useUserStore');

    act(() => useUserStore.getState().updatePreferences({ notificationsEnabled: false }));

    expect(useUserStore.getState().preferences.notificationsEnabled).toBe(false);
  });
});
