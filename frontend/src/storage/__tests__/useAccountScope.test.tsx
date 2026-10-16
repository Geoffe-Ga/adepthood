import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useAccountScope } from '../useActiveUser';
import {
  beginActiveUserTransition,
  getActiveUserGeneration,
  isAccountScopeCurrent,
  setActiveUser,
} from '../userScope';

beforeEach(() => {
  setActiveUser(1);
});
afterEach(() => {
  setActiveUser(null);
});

describe('isAccountScopeCurrent', () => {
  it('holds for the active owner at the active generation', () => {
    expect(isAccountScopeCurrent(1, getActiveUserGeneration())).toBe(true);
  });

  it('fails for another owner at the active generation', () => {
    expect(isAccountScopeCurrent(2, getActiveUserGeneration())).toBe(false);
  });

  it('fails for the active owner at an earlier generation (A to B to A)', () => {
    const epoch = getActiveUserGeneration();
    setActiveUser(2);
    setActiveUser(1);
    expect(isAccountScopeCurrent(1, epoch)).toBe(false);
  });

  it('fails once a transition begins, even before the owner changes', () => {
    const epoch = getActiveUserGeneration();
    beginActiveUserTransition();
    expect(isAccountScopeCurrent(1, epoch)).toBe(false);
  });
});

describe('useAccountScope', () => {
  it('captures the owner and epoch it rendered under', () => {
    const { result } = renderHook(() => useAccountScope());
    expect(result.current.owner).toBe(1);
    expect(result.current.epoch).toBe(getActiveUserGeneration());
    expect(result.current.isCurrent()).toBe(true);
  });

  it('keeps one identity across renders while the account holds', () => {
    const { result, rerender } = renderHook(() => useAccountScope());
    const first = result.current;
    rerender({});
    expect(result.current).toBe(first);
  });

  it('lets a captured scope go stale on A to B to A, and re-captures the new epoch', () => {
    const { result } = renderHook(() => useAccountScope());
    const captured = result.current;
    act(() => {
      setActiveUser(2);
      setActiveUser(1);
    });
    expect(captured.isCurrent()).toBe(false);
    expect(result.current).not.toBe(captured);
    expect(result.current.owner).toBe(1);
    expect(result.current.isCurrent()).toBe(true);
  });
});
