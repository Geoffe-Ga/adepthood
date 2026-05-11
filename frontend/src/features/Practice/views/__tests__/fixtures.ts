import { jest } from '@jest/globals';

import type { EngineStatus, RitualControls, RitualState } from '../../engine/types';

export function fakeState(overrides: Partial<RitualState> = {}): RitualState {
  return {
    status: 'idle',
    elapsedMs: 0,
    remainingMs: null,
    progress: 0,
    repCount: 0,
    currentStepIndex: 0,
    nextCueAtMs: null,
    cuesStruck: 0,
    ...overrides,
  };
}

export function fakeControls(): jest.Mocked<RitualControls> {
  return {
    start: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    cancel: jest.fn(),
    complete: jest.fn(),
    tap: jest.fn(),
    advanceStep: jest.fn(),
  };
}

export const allStatuses: readonly EngineStatus[] = ['idle', 'running', 'paused', 'complete'];
