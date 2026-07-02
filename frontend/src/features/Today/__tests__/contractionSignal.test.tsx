import { describe, expect, it, beforeEach } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { useContractionSignalActive } from '../contractionSignal';

import { useContractionSignalStore } from '@/store/useContractionSignalStore';

beforeEach(() => {
  act(() => {
    useContractionSignalStore.getState().reset();
  });
});

describe('useContractionSignalActive', () => {
  it('returns false initially', () => {
    const { result } = renderHook(() => useContractionSignalActive());

    expect(result.current).toBe(false);
  });

  it('returns true once the store observes a return_offer contraction', () => {
    const { result } = renderHook(() => useContractionSignalActive());

    act(() => {
      useContractionSignalStore.getState().observe({ variant: 'return_offer', message: 'x' });
    });

    expect(result.current).toBe(true);
  });

  it('returns false again once the signal is retracted', () => {
    const { result } = renderHook(() => useContractionSignalActive());
    act(() => {
      useContractionSignalStore.getState().observe({ variant: 'return_offer', message: 'x' });
    });
    expect(result.current).toBe(true);

    act(() => {
      useContractionSignalStore.getState().observe(null);
    });

    expect(result.current).toBe(false);
  });
});
