import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useAccountScope, useActiveUserTransitioning } from '../useActiveUser';
import {
  beginActiveUserTransition,
  getActiveUser,
  getActiveUserGeneration,
  isAccountScopeCurrent,
  scopedKey,
  setActiveUser,
  subscribeActiveUser,
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

describe('transition notifications (#3368)', () => {
  function countNotifications(): { count: () => number; stop: () => void } {
    let calls = 0;
    const stop = subscribeActiveUser(() => {
      calls += 1;
    });
    return { count: () => calls, stop };
  }

  it('notifies subscribers once when cleanup begins, keeping the departing namespace', () => {
    const listener = countNotifications();
    const before = getActiveUserGeneration();
    beginActiveUserTransition();
    expect(listener.count()).toBe(1);
    expect(getActiveUserGeneration()).toBe(before + 1);
    expect(getActiveUser()).toBe(1);
    expect(scopedKey('@adepthood/k')).toBe('@adepthood/k#u1');
    listener.stop();
  });

  it('refuses the cleanup generation itself until a scope is committed', () => {
    beginActiveUserTransition();
    expect(isAccountScopeCurrent(1, getActiveUserGeneration())).toBe(false);
  });

  it('delivers exactly one final notification when cleanup commits another owner', () => {
    beginActiveUserTransition();
    const listener = countNotifications();
    setActiveUser(2);
    expect(listener.count()).toBe(1);
    expect(isAccountScopeCurrent(2, getActiveUserGeneration())).toBe(true);
    listener.stop();
  });

  it('still delivers the final notification when cleanup commits the same owner', () => {
    beginActiveUserTransition();
    const during = getActiveUserGeneration();
    const listener = countNotifications();
    setActiveUser(1);
    expect(listener.count()).toBe(1);
    expect(getActiveUserGeneration()).toBe(during + 1);
    expect(isAccountScopeCurrent(1, getActiveUserGeneration())).toBe(true);
    listener.stop();
  });

  it('stays silent for a same-owner set with no cleanup in flight', () => {
    const listener = countNotifications();
    const before = getActiveUserGeneration();
    setActiveUser(1);
    expect(listener.count()).toBe(0);
    expect(getActiveUserGeneration()).toBe(before);
    listener.stop();
  });

  it('re-renders a mounted scope into a non-current state as cleanup begins', () => {
    const { result } = renderHook(() => useAccountScope());
    const settled = result.current;
    act(() => beginActiveUserTransition());
    expect(result.current).not.toBe(settled);
    expect(result.current.isCurrent()).toBe(false);
    act(() => setActiveUser(1));
    expect(result.current.isCurrent()).toBe(true);
  });

  it('reports the transition to mounted subscribers and clears it on commit', () => {
    const { result } = renderHook(() => useActiveUserTransitioning());
    expect(result.current).toBe(false);
    act(() => beginActiveUserTransition());
    expect(result.current).toBe(true);
    act(() => setActiveUser(2));
    expect(result.current).toBe(false);
  });
});
