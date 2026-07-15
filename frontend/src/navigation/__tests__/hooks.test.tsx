/* eslint-env jest */
/* global describe, it, expect, jest */

const mockUseNavigation = jest.fn();
const mockUseRoute = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: (...args: unknown[]) => mockUseNavigation(...args),
  useRoute: (...args: unknown[]) => mockUseRoute(...args),
}));

import { useAppNavigation, useAppRoute } from '../hooks';

// These wrappers only narrow React Navigation's hooks at compile time; their
// sole runtime behavior is delegating to the underlying hook, so that is all
// these tests exercise. The generic typing is verified by the type-checker,
// not here.
describe('navigation typed hooks', () => {
  it('useAppNavigation delegates to React Navigation useNavigation', () => {
    useAppNavigation();

    expect(mockUseNavigation).toHaveBeenCalledTimes(1);
  });

  it('useAppRoute delegates to React Navigation useRoute', () => {
    useAppRoute<'Practice'>();

    expect(mockUseRoute).toHaveBeenCalledTimes(1);
  });
});
