import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act, renderHook, waitFor } from '@testing-library/react-native';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = jest.requireMock('@react-native-async-storage/async-storage') as {
  setItem: jest.Mock<(_key: string, _value: string) => Promise<void>>;
  getItem: jest.Mock<(_key: string) => Promise<string | null>>;
  removeItem: jest.Mock<(_key: string) => Promise<void>>;
};

import { useFirstRun, useWelcomeStore } from '../useWelcomeStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStorage.getItem.mockResolvedValue(null);
  act(() => {
    useWelcomeStore.setState({ hasSeenWelcome: null });
  });
});

describe('useFirstRun', () => {
  it('returns isFirstRun true once the flag hydrates to unset', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useFirstRun());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(true);
  });

  it('returns isFirstRun false once the flag is set (returning user)', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce('true');
    const { result } = renderHook(() => useFirstRun());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.isFirstRun).toBe(false);
  });

  it('markSeen persists the flag and flips isFirstRun to false', async () => {
    mockAsyncStorage.getItem.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useFirstRun());
    await waitFor(() => expect(result.current.isFirstRun).toBe(true));
    act(() => result.current.markSeen());
    expect(result.current.isFirstRun).toBe(false);
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith('@adepthood/has_seen_welcome', 'true');
  });
});

describe('useWelcomeStore.reset', () => {
  it('clears the flag in memory and storage', () => {
    act(() => {
      useWelcomeStore.getState().hydrateHasSeenWelcome(true);
      useWelcomeStore.getState().reset();
    });
    expect(useWelcomeStore.getState().hasSeenWelcome).toBeNull();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/has_seen_welcome');
  });
});
