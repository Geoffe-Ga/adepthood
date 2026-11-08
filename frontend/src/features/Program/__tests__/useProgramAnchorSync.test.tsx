import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';

import { useProgramAnchorSync } from '../useProgramAnchorSync';

const mockReconcile = jest.fn<(_tz: string) => Promise<void>>();
jest.mock('../programAnchor', () => ({
  reconcileProgramAnchor: (tz: string) => mockReconcile(tz),
}));

interface AuthSlice {
  authStatus: string;
  userTimezone: string;
  userTimezoneReady: boolean;
}
let mockAuth: AuthSlice;
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

beforeEach(() => {
  mockReconcile.mockReset().mockResolvedValue(undefined);
  mockAuth = { authStatus: 'authenticated', userTimezone: 'Europe/Paris', userTimezoneReady: true };
});

describe('useProgramAnchorSync', () => {
  it('reconciles once per signed-in session, in the account zone', () => {
    const { rerender } = renderHook(() => useProgramAnchorSync());
    rerender({});

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith('Europe/Paris');
  });

  it('waits while signed out', () => {
    mockAuth = { ...mockAuth, authStatus: 'unauthenticated' };
    renderHook(() => useProgramAnchorSync());
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('waits while the account zone is still provisional', () => {
    mockAuth = { ...mockAuth, userTimezoneReady: false };
    renderHook(() => useProgramAnchorSync());
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});
