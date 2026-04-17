/* eslint-env jest */
/* global describe, it, expect, jest */
import { renderHook } from '@testing-library/react-native';

import { useRouteParams } from '../hooks';

// Minimal mock of @react-navigation's ``useRoute`` so we can drive the hook
// under test without wiring a real NavigationContainer.
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({
    key: 'Course-test',
    name: 'Course',
    params: (globalThis as unknown as { __params?: unknown }).__params,
  }),
  useNavigation: () => ({ navigate: jest.fn() }),
}));

function withParams<T>(params: T, fn: () => void): void {
  (globalThis as unknown as { __params?: unknown }).__params = params;
  try {
    fn();
  } finally {
    (globalThis as unknown as { __params?: unknown }).__params = undefined;
  }
}

describe('useRouteParams (BUG-FRONTEND-INFRA-023)', () => {
  it('returns defaults when params is undefined', () => {
    withParams(undefined, () => {
      const { result } = renderHook(() =>
        useRouteParams<'Course', { stageNumber: number }>('Course', { stageNumber: 1 }),
      );
      expect(result.current.stageNumber).toBe(1);
    });
  });

  it('merges partial params over defaults', () => {
    withParams({ stageNumber: 7 }, () => {
      const { result } = renderHook(() =>
        useRouteParams<'Course', { stageNumber: number }>('Course', { stageNumber: 1 }),
      );
      expect(result.current.stageNumber).toBe(7);
    });
  });

  it('treats explicit undefined as missing (applies default)', () => {
    withParams({ stageNumber: undefined as unknown as number }, () => {
      const { result } = renderHook(() =>
        useRouteParams<'Course', { stageNumber: number }>('Course', { stageNumber: 3 }),
      );
      expect(result.current.stageNumber).toBe(3);
    });
  });
});
