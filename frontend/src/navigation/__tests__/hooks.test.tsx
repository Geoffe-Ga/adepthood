/* eslint-env jest */
/* global describe, it, expect, jest */

const mockUseNavigation = jest.fn();
const mockUseRoute = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: (...args: unknown[]) => mockUseNavigation(...args),
  useRoute: (...args: unknown[]) => mockUseRoute(...args),
}));

import { useAppNavigation, useAppRoute } from '../hooks';

describe('useAppNavigation', () => {
  it('returns a typed BottomTabNavigationProp', () => {
    const fakeNav = { navigate: jest.fn(), goBack: jest.fn() };
    mockUseNavigation.mockReturnValue(fakeNav);

    const result = useAppNavigation();

    expect(result).toBe(fakeNav);
    expect(result.navigate).toBeDefined();
  });
});

describe('useAppRoute', () => {
  it('returns a typed route for a given screen name', () => {
    const fakeRoute = {
      key: 'Practice-abc',
      name: 'Practice',
      params: { stageNumber: 3 },
    };
    mockUseRoute.mockReturnValue(fakeRoute);

    const result = useAppRoute<'Practice'>();

    expect(result).toBe(fakeRoute);
    expect(result.params?.stageNumber).toBe(3);
  });

  it('returns a route with undefined params for screens without params', () => {
    const fakeRoute = {
      key: 'Habits-abc',
      name: 'Habits',
      params: undefined,
    };
    mockUseRoute.mockReturnValue(fakeRoute);

    const result = useAppRoute<'Habits'>();

    expect(result).toBe(fakeRoute);
    expect(result.params).toBeUndefined();
  });

  it('returns a route with Journal params', () => {
    const fakeRoute = {
      key: 'Journal-abc',
      name: 'Journal',
      params: { practiceSessionId: 42, practiceName: 'Meditation' },
    };
    mockUseRoute.mockReturnValue(fakeRoute);

    const result = useAppRoute<'Journal'>();

    expect(result.params?.practiceSessionId).toBe(42);
    expect(result.params?.practiceName).toBe('Meditation');
  });
});
