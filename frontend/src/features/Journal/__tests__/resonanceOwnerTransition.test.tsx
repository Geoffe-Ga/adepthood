import { beforeEach, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useResonanceExplainer } from '../useResonanceExplainer';

import { setActiveUser } from '@/storage/userScope';

const mockAuth = {
  token: 'test.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test',
  authStatus: 'authenticated',
};
const mockLoadDismissed = jest.fn<() => Promise<boolean>>();
const mockUsage = jest.fn<() => Promise<Record<string, unknown>>>();
jest.mock('@/context/AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('@/context/ApiKeyContext', () => ({
  useApiKey: () => ({ apiKey: null, isLoading: false }),
}));
jest.mock('@/api', () => ({ botmasonUsage: { get: () => mockUsage() } }));
jest.mock('@/storage/resonanceExplainerStorage', () => ({
  loadResonanceExplainerDismissed: () => mockLoadDismissed(),
  saveResonanceExplainerDismissed: async () => undefined,
}));

beforeEach(() => {
  setActiveUser(1);
  mockAuth.token = 'test.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test';
  mockAuth.authStatus = 'authenticated';
  mockUsage.mockReset();
  mockLoadDismissed.mockReset().mockResolvedValue(false);
});

it('discards a held owner A route after reauthentication as B with the same key state', async () => {
  let release = (_value: Record<string, unknown>): void => undefined;
  mockUsage.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const run = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(() => useResonanceExplainer(run));
  await act(async () => undefined);
  let pending: Promise<void> = Promise.resolve();
  await act(async () => {
    pending = result.current.onPress();
  });
  expect(mockUsage).toHaveBeenCalledTimes(1);
  mockAuth.authStatus = 'reauth-required';
  rerender({});
  setActiveUser(2);
  mockAuth.token = 'test.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test';
  mockAuth.authStatus = 'authenticated';
  rerender({});
  await act(async () => {
    release({
      resonance_route: 'vault_bound',
      monthly_messages_remaining: 0,
      monthly_messages_used: 20,
      monthly_cap: 20,
      offering_balance: 0,
      monthly_reset_date: '2026-11-01T00:00:00Z',
    });
    await pending;
  });
  expect(result.current.refillVisible).toBe(false);
  expect(result.current.visible).toBe(false);
  expect(result.current.continueDisabled).toBe(true);
  expect(result.current.cost).not.toMatch(/spends|balance has run out/u);
  expect(run).not.toHaveBeenCalled();
});

it('cannot activate owner A disclosure after owner B replaces the mounted session', async () => {
  mockUsage.mockResolvedValue({
    resonance_route: 'vault_bound',
    monthly_messages_remaining: 20,
    monthly_messages_used: 0,
    monthly_cap: 20,
    offering_balance: 0,
    monthly_reset_date: '2026-11-01T00:00:00Z',
  });
  const run = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(() => useResonanceExplainer(run));
  await act(async () => {
    await result.current.onPress();
  });
  expect(result.current.visible).toBe(true);
  expect(result.current.continueDisabled).toBe(false);
  const staleContinue = result.current.onContinue;
  setActiveUser(2);
  mockAuth.token = 'test.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test';
  rerender({});
  await act(async () => {
    staleContinue();
  });
  expect(run).not.toHaveBeenCalled();
  expect(result.current.visible).toBe(false);
});

it('reads B dismissal independently rather than reusing A automatic continuation', async () => {
  mockLoadDismissed.mockResolvedValueOnce(true).mockResolvedValue(false);
  mockUsage.mockResolvedValue({
    resonance_route: 'vault_bound',
    monthly_messages_remaining: 20,
    monthly_messages_used: 0,
    monthly_cap: 20,
    offering_balance: 0,
    monthly_reset_date: '2026-11-01T00:00:00Z',
  });
  const run = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(() => useResonanceExplainer(run));
  await act(async () => undefined);
  setActiveUser(2);
  mockAuth.token = 'test.eyJzdWIiOiIyIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test';
  rerender({});
  await act(async () => {
    await result.current.onPress();
  });
  expect(mockLoadDismissed).toHaveBeenCalledTimes(2);
  expect(result.current.visible).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

it('does not start a new payment lookup while reauthentication is required', async () => {
  mockAuth.authStatus = 'reauth-required';
  const run = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const { result } = renderHook(() => useResonanceExplainer(run));
  await act(async () => {
    await result.current.onPress();
  });
  expect(mockUsage).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it.each([{ owners: [2] }, { owners: [2, 1] }])(
  'rejects namespace changes $owners before the mounted auth context rerenders',
  async ({ owners }) => {
    let release = (_value: Record<string, unknown>): void => undefined;
    mockUsage.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const run = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { result } = renderHook(() => useResonanceExplainer(run));
    await act(async () => undefined);
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.onPress();
    });
    for (const owner of owners) setActiveUser(owner);
    await act(async () => {
      release({
        resonance_route: 'vault_bound',
        monthly_messages_remaining: 0,
        monthly_messages_used: 20,
        monthly_cap: 20,
        offering_balance: 0,
        monthly_reset_date: '2026-11-01T00:00:00Z',
      });
      await pending;
    });
    expect(result.current.refillVisible).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(run).not.toHaveBeenCalled();
  },
);

it('does not start a cost read when the new namespace and rendered credential disagree', async () => {
  const run = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const { result, rerender } = renderHook(() => useResonanceExplainer(run));
  await act(async () => undefined);
  setActiveUser(2);
  rerender({});
  await act(async () => {
    await result.current.onPress();
  });
  expect(mockUsage).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
