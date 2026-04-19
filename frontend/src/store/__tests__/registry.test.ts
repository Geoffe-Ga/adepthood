/**
 * BUG-FE-STATE-001: logout must wipe every in-memory store and every
 * persistence key so the next user on the device does not inherit the old
 * user's habits, stage progress, journal drafts, etc. The registry is the
 * single place every store publishes its reset callback — ``resetAllStores``
 * walks the registry so ``AuthContext.logout`` never has to know which
 * stores exist.
 */
import { describe, expect, it, beforeEach, jest } from '@jest/globals';

import { __resetRegistryForTests, registerStoreReset, resetAllStores } from '../registry';

describe('store reset registry (BUG-FE-STATE-001)', () => {
  beforeEach(() => {
    __resetRegistryForTests();
  });

  it('invokes every registered reset callback when resetAllStores is called', () => {
    const resetA = jest.fn();
    const resetB = jest.fn();
    registerStoreReset(resetA);
    registerStoreReset(resetB);

    resetAllStores();

    expect(resetA).toHaveBeenCalledTimes(1);
    expect(resetB).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — calling resetAllStores twice invokes each callback twice', () => {
    const reset = jest.fn();
    registerStoreReset(reset);

    resetAllStores();
    resetAllStores();

    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('continues resetting remaining stores even if one reset throws', () => {
    const boom = jest.fn(() => {
      throw new Error('store A exploded');
    });
    const resetB = jest.fn();
    registerStoreReset(boom);
    registerStoreReset(resetB);

    // A thrown reset must not prevent the rest from running — a user-visible
    // logout that silently keeps a store of a previous user's data would
    // reintroduce BUG-FE-STATE-001.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      resetAllStores();
    } finally {
      warnSpy.mockRestore();
    }

    expect(boom).toHaveBeenCalledTimes(1);
    expect(resetB).toHaveBeenCalledTimes(1);
  });

  it('deduplicates — registering the same callback twice only runs it once', () => {
    const reset = jest.fn();
    registerStoreReset(reset);
    registerStoreReset(reset);

    resetAllStores();

    expect(reset).toHaveBeenCalledTimes(1);
  });
});
