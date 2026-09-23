import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor } from '@testing-library/react-native';

const mockCapabilities = jest.fn<(_token?: string) => Promise<{ feedback_triage: boolean }>>();
let mockToken: string | null = 'operator-token';

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    adminFeedback: { capabilities: (token?: string) => mockCapabilities(token) },
  };
});

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: mockToken }),
}));

import { useAdminCapability } from '../useAdminCapability';

import { ApiError } from '@/api';

const HTTP_FORBIDDEN = 403;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;

beforeEach(() => {
  mockCapabilities.mockReset();
  mockToken = 'operator-token';
});

describe('useAdminCapability', () => {
  it('is unknown until the server answers, then admin on a 200', async () => {
    let resolve: (_value: { feedback_triage: boolean }) => void = () => undefined;
    mockCapabilities.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { result } = renderHook(() => useAdminCapability());

    expect(result.current.capability).toBe('unknown');
    resolve({ feedback_triage: true });
    await waitFor(() => expect(result.current.capability).toBe('admin'));
    expect(mockCapabilities).toHaveBeenCalledWith('operator-token');
  });

  it('is not-admin when the server says the feature is off', async () => {
    mockCapabilities.mockResolvedValue({ feedback_triage: false });
    const { result } = renderHook(() => useAdminCapability());
    await waitFor(() => expect(result.current.capability).toBe('not-admin'));
  });

  it.each([HTTP_FORBIDDEN, HTTP_UNAUTHORIZED])('is not-admin on a %i', async (status) => {
    mockCapabilities.mockRejectedValue(new ApiError(status, 'admin_required'));
    const { result } = renderHook(() => useAdminCapability());
    await waitFor(() => expect(result.current.capability).toBe('not-admin'));
  });

  it('is unavailable, not admin, when the question cannot be answered', async () => {
    mockCapabilities.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'server_error'));
    const { result } = renderHook(() => useAdminCapability());
    await waitFor(() => expect(result.current.capability).toBe('unavailable'));
  });

  it('makes no request at all while signed out', async () => {
    mockToken = null;
    const { result } = renderHook(() => useAdminCapability());
    await waitFor(() => expect(result.current.capability).toBe('not-admin'));
    expect(mockCapabilities).not.toHaveBeenCalled();
  });
});
