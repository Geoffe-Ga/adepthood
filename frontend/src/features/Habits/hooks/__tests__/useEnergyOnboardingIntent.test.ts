import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { renderHook } from '@testing-library/react-native';

import {
  useEnergyOnboardingIntent,
  type EnergyOnboardingParams,
} from '../useEnergyOnboardingIntent';

import { getActiveUserGeneration, setActiveUser } from '@/storage/userScope';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

beforeEach(() => {
  setActiveUser(1);
  useDepthPreferencesStore.setState({ enable_habits: true });
});
describe('a consume-once Energy onboarding request', () => {
  it('consumes a cold request and opens once even while the navigator is clearing its params', () => {
    const clear = jest.fn();
    const open = jest.fn();
    const params: EnergyOnboardingParams = {
      onboardingIntent: 'energy-scaffolding',
      onboardingOwner: 1,
      onboardingGeneration: getActiveUserGeneration(),
    };
    const view = renderHook(
      ({ request, callback }: { request: EnergyOnboardingParams; callback: () => void }) =>
        useEnergyOnboardingIntent(request, clear, callback),
      { initialProps: { request: params, callback: open } },
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    const replacement = jest.fn();
    view.rerender({ request: params, callback: replacement });
    expect(replacement).not.toHaveBeenCalled();
  });
  it('accepts a new request on an already-mounted tab after the prior intent was cleared', () => {
    const clear = jest.fn();
    const open = jest.fn();
    const view = renderHook(
      ({ params }: { params: EnergyOnboardingParams | undefined }) =>
        useEnergyOnboardingIntent(params, clear, open),
      { initialProps: { params: undefined as EnergyOnboardingParams | undefined } },
    );
    const params: EnergyOnboardingParams = {
      onboardingIntent: 'energy-scaffolding',
      onboardingOwner: 1,
      onboardingGeneration: getActiveUserGeneration(),
    };
    view.rerender({ params });
    view.rerender({ params: undefined });
    view.rerender({ params });
    expect(open).toHaveBeenCalledTimes(2);
  });
  it('consumes but does not replay an old intent after A to B to A', () => {
    const params: EnergyOnboardingParams = {
      onboardingIntent: 'energy-scaffolding',
      onboardingOwner: 1,
      onboardingGeneration: getActiveUserGeneration(),
    };
    setActiveUser(2);
    setActiveUser(1);
    const clear = jest.fn();
    const open = jest.fn();
    renderHook(() => useEnergyOnboardingIntent(params, clear, open));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it.each([
    ['a different account', 2, true],
    ['a disabled Habits ring', 1, false],
  ])('consumes but does not open for %s', (_label, owner, enabled) => {
    setActiveUser(owner as number);
    useDepthPreferencesStore.setState({ enable_habits: enabled as boolean });
    const clear = jest.fn();
    const open = jest.fn();
    renderHook(() =>
      useEnergyOnboardingIntent(
        {
          onboardingIntent: 'energy-scaffolding',
          onboardingOwner: 1,
          onboardingGeneration: getActiveUserGeneration(),
        },
        clear,
        open,
      ),
    );
    expect(clear).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
