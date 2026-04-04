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
    expect(result.current.emojiPicker).toBe(false);
    expect(result.current.menu).toBe(false);
  });

  it('opens exactly one modal at a time', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.open('goal'));
    expect(result.current.goal).toBe(true);
    expect(result.current.stats).toBe(false);

    act(() => result.current.open('stats'));
    expect(result.current.stats).toBe(true);
    expect(result.current.goal).toBe(false);
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
    expect(result.current.emojiPicker).toBe(false);
    expect(result.current.menu).toBe(false);
  });

  it('close(name) closes only that modal', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.open('goal'));
    act(() => result.current.close('goal'));
    expect(result.current.goal).toBe(false);
  });

  it('toggleMenu toggles the menu state', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.toggleMenu());
    expect(result.current.menu).toBe(true);

    act(() => result.current.toggleMenu());
    expect(result.current.menu).toBe(false);
  });

  it('opening a modal closes the menu', () => {
    const { result } = renderHook(() => useModalCoordinator());

    act(() => result.current.toggleMenu());
    expect(result.current.menu).toBe(true);

    act(() => result.current.open('goal'));
    expect(result.current.menu).toBe(false);
    expect(result.current.goal).toBe(true);
  });
});
