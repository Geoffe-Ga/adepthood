import { describe, expect, it, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import { useContractionSignalStore } from '../useContractionSignalStore';

import type { ContractionReflection } from '@/api';

function returnOffer(): ContractionReflection {
  return { variant: 'return_offer', message: 'x' };
}

function simpleEaseOff(): ContractionReflection {
  return { variant: 'simple_ease_off', message: 'x' };
}

beforeEach(() => {
  act(() => {
    useContractionSignalStore.getState().reset();
  });
});

describe('useContractionSignalStore', () => {
  it('starts inactive', () => {
    expect(useContractionSignalStore.getState().active).toBe(false);
  });

  it('observe sets active true for a return_offer contraction', () => {
    act(() => {
      useContractionSignalStore.getState().observe(returnOffer());
    });

    expect(useContractionSignalStore.getState().active).toBe(true);
  });

  it('observe sets active false for a simple_ease_off contraction, retracting a prior true', () => {
    act(() => {
      useContractionSignalStore.getState().observe(returnOffer());
    });
    expect(useContractionSignalStore.getState().active).toBe(true);

    act(() => {
      useContractionSignalStore.getState().observe(simpleEaseOff());
    });

    expect(useContractionSignalStore.getState().active).toBe(false);
  });

  it('observe(null) retracts a prior true signal', () => {
    act(() => {
      useContractionSignalStore.getState().observe(returnOffer());
    });
    expect(useContractionSignalStore.getState().active).toBe(true);

    act(() => {
      useContractionSignalStore.getState().observe(null);
    });

    expect(useContractionSignalStore.getState().active).toBe(false);
  });

  it('reset returns to the initial inactive state', () => {
    act(() => {
      useContractionSignalStore.getState().observe(returnOffer());
      useContractionSignalStore.getState().reset();
    });

    expect(useContractionSignalStore.getState().active).toBe(false);
  });

  it('registers its reset with the shared store registry so logout wipes it', () => {
    const { resetAllStores } = require('../registry');

    act(() => {
      useContractionSignalStore.getState().observe(returnOffer());
    });
    expect(useContractionSignalStore.getState().active).toBe(true);

    act(() => resetAllStores());

    expect(useContractionSignalStore.getState().active).toBe(false);
  });
});
