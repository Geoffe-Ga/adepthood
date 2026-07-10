import { describe, expect, it } from '@jest/globals';
import { renderHook, act } from '@testing-library/react-native';

import { useModalCoordinator } from '../hooks/useModalCoordinator';

describe('useModalCoordinator', () => {
  it('starts with all modals closed', () => {
    const { result } = renderHook(() => useModalCoordinator());

    expect(result.current.goal).toBe(false);
    expect(result.current.stats).toBe(false);
    expect(result.current.settings).toBe(false);
    expect(result.current.reorder).toBe(false);
    expect(result.current.missedDays).toBe(false);
    expect(result.current.onboarding).toBe(false);
    expect(result.current.addHabit).toBe(false);
    expect(result.current.emojiPicker).toBe(false);
  });

  it('BUG-FE-HABIT-008: open() preserves prior modal flags', () => {
    // Before the fix, ``open('stats')`` would close ``goal``.  Stacking
    // a count-warning toast inside the onboarding flow then dismissed
    // onboarding itself.  ``open`` now ORs the requested flag onto
    // existing state; callers that need exclusivity ``closeAll()`` first.
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.open('goal'));
    expect(result.current.goal).toBe(true);
    expect(result.current.stats).toBe(false);

    act(() => result.current.open('stats'));
    expect(result.current.stats).toBe(true);
    expect(result.current.goal).toBe(true);
  });

  it('closeAll resets every modal to false', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.open('settings'));
    expect(result.current.settings).toBe(true);

    act(() => result.current.closeAll());
    expect(result.current.goal).toBe(false);
    expect(result.current.stats).toBe(false);
    expect(result.current.settings).toBe(false);
    expect(result.current.reorder).toBe(false);
    expect(result.current.missedDays).toBe(false);
    expect(result.current.onboarding).toBe(false);
    expect(result.current.addHabit).toBe(false);
    expect(result.current.emojiPicker).toBe(false);
  });

  it('open("addHabit") opens the AddHabit modal', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.open('addHabit'));
    expect(result.current.addHabit).toBe(true);
  });

  it('close(name) closes only that modal', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.open('goal'));
    act(() => result.current.close('goal'));
    expect(result.current.goal).toBe(false);
  });
});
