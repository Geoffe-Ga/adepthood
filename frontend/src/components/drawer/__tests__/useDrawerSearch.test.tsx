import { describe, expect, it, jest } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useDrawerSearch } from '@/components/drawer';

function renderSearch() {
  const onConfirmBodySearch = jest.fn();
  const hook = renderHook(() => useDrawerSearch(onConfirmBodySearch));
  return { ...hook, onConfirmBodySearch };
}

describe('useDrawerSearch', () => {
  it('starts with no query, not searching, and the body gate closed', () => {
    const { result } = renderSearch();
    expect(result.current.query).toBe('');
    expect(result.current.isSearching).toBe(false);
    expect(result.current.bodySearchActive).toBe(false);
  });

  it('tracks the query and whether a search is active', () => {
    const { result } = renderSearch();
    act(() => result.current.handleQueryChange('ritual'));
    expect(result.current.query).toBe('ritual');
    expect(result.current.isSearching).toBe(true);

    act(() => result.current.handleQueryChange(''));
    expect(result.current.query).toBe('');
    expect(result.current.isSearching).toBe(false);
  });

  it('opens the body gate on confirm and asks the host to sweep exactly once', () => {
    const { result, onConfirmBodySearch } = renderSearch();
    act(() => result.current.handleQueryChange('ritual'));
    act(() => result.current.handleConfirmDeepSearch());
    expect(result.current.bodySearchActive).toBe(true);
    expect(onConfirmBodySearch).toHaveBeenCalledTimes(1);
  });

  it('keeps the gate open across a non-empty query change', () => {
    const { result } = renderSearch();
    act(() => result.current.handleQueryChange('ritual'));
    act(() => result.current.handleConfirmDeepSearch());
    act(() => result.current.handleQueryChange('rituals'));
    expect(result.current.bodySearchActive).toBe(true);
  });

  it('closes the gate when the query is cleared', () => {
    const { result, onConfirmBodySearch } = renderSearch();
    act(() => result.current.handleQueryChange('ritual'));
    act(() => result.current.handleConfirmDeepSearch());
    act(() => result.current.handleQueryChange(''));
    expect(result.current.bodySearchActive).toBe(false);
    expect(onConfirmBodySearch).toHaveBeenCalledTimes(1);
  });
});
