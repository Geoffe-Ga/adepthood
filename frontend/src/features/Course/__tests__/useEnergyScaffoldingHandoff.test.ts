import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useEnergyScaffoldingHandoff } from '../useEnergyScaffoldingHandoff';

import { depthPreferences, type DepthPreferences } from '@/api';
import { setActiveUser } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

const TOKEN = 'e30.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.signature';
let mockToken: string | undefined = TOKEN;
jest.mock('@/api', () => ({
  captureSessionToken: () => mockToken,
  depthPreferences: { get: jest.fn() },
}));
const preferences = {
  enable_habits: true,
  enable_course: true,
  enable_practices: true,
  enable_sangha: true,
};
function deferred<T>() {
  let resolve!: (_value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  mockToken = TOKEN;
  setActiveUser(1);
  useDepthPreferencesStore.setState({ enable_habits: true });
  jest.mocked(depthPreferences.get).mockReset().mockResolvedValue(preferences);
});
describe('confirmed Energy scaffolding hand-off', () => {
  it('waits for the actual server choice instead of the initial default-on cache', async () => {
    const lookup = deferred<DepthPreferences>();
    jest.mocked(depthPreferences.get).mockReturnValueOnce(lookup.promise);
    const open = jest.fn();
    const view = renderHook(() => useEnergyScaffoldingHandoff(true, open));
    act(() => view.result.current.start());
    expect(view.result.current.status).toBe('checking');
    expect(open).not.toHaveBeenCalled();
    await act(async () => lookup.resolve({ ...preferences, enable_habits: false }));
    expect(view.result.current.status).toBe('disabled');
    expect(open).not.toHaveBeenCalled();
    expect(depthPreferences.get).toHaveBeenCalledWith(TOKEN);
    expect(useDepthPreferencesStore.getState().enable_habits).toBe(true);
  });
  it('opens the existing onboarding only for the confirmed captured account', async () => {
    const open = jest.fn();
    const view = renderHook(() => useEnergyScaffoldingHandoff(true, open));
    await act(async () => view.result.current.start());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ owner: 1, token: TOKEN }));
  });
  it('sends nothing when the cache namespace and credential belong to different accounts', async () => {
    setActiveUser(2);
    const open = jest.fn();
    const view = renderHook(() => useEnergyScaffoldingHandoff(true, open));
    await act(async () => view.result.current.start());
    expect(depthPreferences.get).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it('drops a held confirmation after A to B to A', async () => {
    const lookup = deferred<DepthPreferences>();
    jest.mocked(depthPreferences.get).mockReturnValueOnce(lookup.promise);
    const open = jest.fn();
    const view = renderHook(() => useEnergyScaffoldingHandoff(true, open));
    act(() => view.result.current.start());
    setActiveUser(2);
    setActiveUser(1);
    await act(async () => lookup.resolve(preferences));
    expect(open).not.toHaveBeenCalled();
  });
  it('keeps a failed confirmation retryable and coalesces repeated presses while checking', async () => {
    const lookup = deferred<DepthPreferences>();
    jest
      .mocked(depthPreferences.get)
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(lookup.promise);
    const open = jest.fn();
    const view = renderHook(() => useEnergyScaffoldingHandoff(true, open));
    await act(async () => view.result.current.start());
    expect(view.result.current.status).toBe('error');
    act(() => {
      view.result.current.start();
      view.result.current.start();
    });
    expect(depthPreferences.get).toHaveBeenCalledTimes(2);
    await act(async () => lookup.resolve(preferences));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
