import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { habitSyncScopeKey } from '../../services/habitSyncScope';
import {
  useEnergyOnboardingIntent,
  type EnergyOnboardingParams,
} from '../useEnergyOnboardingIntent';

import { beginAuthSession, getAuthSession } from '@/api/sessionToken';
import { getActiveUserGeneration, setActiveUser } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';
import { useHabitStore } from '@/store/useHabitStore';

const request = (owner = 1): EnergyOnboardingParams => ({
  onboardingIntent: 'energy-scaffolding',
  onboardingOwner: owner,
  onboardingGeneration: getActiveUserGeneration(),
  onboardingSession: getAuthSession(),
});

/** What a finished `refreshHabits` records for the account and session now live. */
const settle = (status: 'ok' | 'failed', scope = habitSyncScopeKey()) =>
  act(() => {
    useHabitStore.getState().setServerSync({ scope, status });
  });

beforeEach(() => {
  setActiveUser(1);
  useDepthPreferencesStore.setState({ enable_habits: true });
  useHabitStore.getState().reset();
});

describe('a consume-once Energy onboarding request', () => {
  it('consumes a warm request and opens once even while the navigator is clearing its params', () => {
    settle('ok');
    const clear = jest.fn();
    const open = jest.fn();
    const params = request();
    const view = renderHook(
      ({ intent, callback }: { intent: EnergyOnboardingParams; callback: () => void }) =>
        useEnergyOnboardingIntent(intent, clear, callback),
      { initialProps: { intent: params, callback: open } },
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(view.result.current.status).toBe('idle');
    const replacement = jest.fn();
    view.rerender({ intent: params, callback: replacement });
    expect(replacement).not.toHaveBeenCalled();
  });

  it('accepts a new request on an already-mounted tab after the prior intent was cleared', () => {
    settle('ok');
    const clear = jest.fn();
    const open = jest.fn();
    const view = renderHook(
      ({ params }: { params: EnergyOnboardingParams | undefined }) =>
        useEnergyOnboardingIntent(params, clear, open),
      { initialProps: { params: undefined as EnergyOnboardingParams | undefined } },
    );
    const params = request();
    view.rerender({ params });
    view.rerender({ params: undefined });
    view.rerender({ params });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('consumes but does not replay an old intent after A to B to A', () => {
    const params = request();
    setActiveUser(2);
    setActiveUser(1);
    settle('ok');
    const clear = jest.fn();
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(params, clear, open));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
  });

  it.each([
    ['a different account', 2, true],
    ['a disabled Habits ring', 1, false],
  ])('consumes but does not open for %s', (_label, owner, enabled) => {
    setActiveUser(owner as number);
    useDepthPreferencesStore.setState({ enable_habits: enabled as boolean });
    settle('ok');
    const clear = jest.fn();
    const open = jest.fn();
    const view = renderHook(() =>
      useEnergyOnboardingIntent(
        { ...request(), onboardingOwner: 1, onboardingGeneration: getActiveUserGeneration() },
        clear,
        open,
      ),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
  });
});

describe('a cold request waits for the account’s own habits (#3328)', () => {
  it('holds the review until the server list for this account and session is read', () => {
    const clear = jest.fn();
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), clear, open));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('waiting');
    settle('ok');
    expect(open).toHaveBeenCalledTimes(1);
    expect(view.result.current.status).toBe('idle');
    settle('ok');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed read retryable: the handoff opens once a later read succeeds', () => {
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), jest.fn(), open));
    settle('failed');
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('failed');
    act(() => {
      useHabitStore.getState().setServerSync(null);
    });
    expect(view.result.current.status).toBe('waiting');
    settle('ok');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not take a read from an earlier authentication session as this one’s', () => {
    const stale = habitSyncScopeKey();
    beginAuthSession();
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), jest.fn(), open));
    settle('ok', stale);
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('waiting');
    settle('failed', stale);
    expect(view.result.current.status).toBe('waiting');
  });

  it('drops the handoff when the account changes while the read is held', () => {
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), jest.fn(), open));
    setActiveUser(2);
    setActiveUser(1);
    settle('ok');
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
  });

  it('drops the handoff when the Habits ring turns off while the read is held', () => {
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), jest.fn(), open));
    act(() => {
      useDepthPreferencesStore.setState({ enable_habits: false });
    });
    settle('ok');
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
    act(() => {
      useDepthPreferencesStore.setState({ enable_habits: true });
    });
    settle('ok');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('declining a held handoff', () => {
  it('drops it in one tap, so a later read does not open the review', () => {
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), jest.fn(), open));
    act(() => {
      view.result.current.cancel();
    });
    expect(view.result.current.status).toBe('idle');
    settle('ok');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('the session a request was made in (#3423)', () => {
  it('consumes but never opens a request that names no session', () => {
    settle('ok');
    const clear = jest.fn();
    const open = jest.fn();
    const sessionless: EnergyOnboardingParams = { ...request(), onboardingSession: undefined };
    const view = renderHook(() => useEnergyOnboardingIntent(sessionless, clear, open));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
  });

  it('drops a held request once its session ends, even for the same account', () => {
    const open = jest.fn();
    const view = renderHook(() => useEnergyOnboardingIntent(request(), jest.fn(), open));
    expect(view.result.current.status).toBe('waiting');
    beginAuthSession();
    settle('ok');
    expect(open).not.toHaveBeenCalled();
    expect(view.result.current.status).toBe('idle');
  });
});
