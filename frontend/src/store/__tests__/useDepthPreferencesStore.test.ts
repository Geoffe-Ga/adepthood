import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act } from '@testing-library/react-native';

import type { DepthPreferences, DepthPreferencesUpdate } from '../../api';

// Mock the entire api module before any store import resolves
jest.mock('../../api', () => ({
  depthPreferences: {
    get: jest.fn(() =>
      Promise.resolve({
        enable_habits: true,
        enable_practices: true,
        enable_course: true,
        enable_sangha: true,
      }),
    ),
    update: jest.fn(() =>
      Promise.resolve({
        enable_habits: true,
        enable_practices: true,
        enable_course: true,
        enable_sangha: true,
      }),
    ),
  },
}));

const mockApi = jest.requireMock('../../api') as {
  depthPreferences: {
    get: jest.Mock<(token?: string) => Promise<DepthPreferences>>;
    update: jest.Mock<
      (partial: DepthPreferencesUpdate, token?: string) => Promise<DepthPreferences>
    >;
  };
};

const ALL_ON = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

describe('useDepthPreferencesStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore all-on defaults between tests
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');
    act(() => {
      useDepthPreferencesStore.getState().reset();
    });
  });

  it('initial state is all-on', () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');
    const state = useDepthPreferencesStore.getState();

    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(true);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(true);
  });

  it('load() stores the returned booleans', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    const serverResponse = {
      enable_habits: true,
      enable_practices: false,
      enable_course: true,
      enable_sangha: false,
    };
    mockApi.depthPreferences.get.mockResolvedValueOnce(serverResponse);

    await act(async () => {
      await useDepthPreferencesStore.getState().load('tok');
    });

    const state = useDepthPreferencesStore.getState();
    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(false);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(false);
  });

  it('load() calls depthPreferences.get with the supplied token', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');
    mockApi.depthPreferences.get.mockResolvedValueOnce(ALL_ON);

    await act(async () => {
      await useDepthPreferencesStore.getState().load('my-token');
    });

    expect(mockApi.depthPreferences.get).toHaveBeenCalledWith('my-token');
  });

  it('update() calls depthPreferences.update with the partial and sets RETURNED full state', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    const serverFull = {
      enable_habits: true,
      enable_practices: true,
      enable_course: false,
      enable_sangha: true,
    };
    mockApi.depthPreferences.update.mockResolvedValueOnce(serverFull);

    // Confirm the value is NOT set before promise resolves
    const stateBefore = useDepthPreferencesStore.getState().enable_course;
    expect(stateBefore).toBe(true);

    await act(async () => {
      await useDepthPreferencesStore.getState().update({ enable_course: false }, 'tok');
    });

    expect(mockApi.depthPreferences.update).toHaveBeenCalledWith({ enable_course: false }, 'tok');
    // State comes from the server response, not optimistic pre-set
    const state = useDepthPreferencesStore.getState();
    expect(state.enable_course).toBe(false);
    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(true);
    expect(state.enable_sangha).toBe(true);
  });

  it('update() does NOT optimistically pre-set before the promise resolves', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    let stateWhileInFlight: boolean | undefined;

    mockApi.depthPreferences.update.mockImplementationOnce(
      () =>
        new Promise<DepthPreferences>((resolve) => {
          // Capture store state BEFORE the promise resolves
          stateWhileInFlight = useDepthPreferencesStore.getState().enable_sangha;
          resolve({ ...ALL_ON, enable_sangha: false });
        }),
    );

    await act(async () => {
      await useDepthPreferencesStore.getState().update({ enable_sangha: false }, 'tok');
    });

    // Still true mid-flight (no optimistic update)
    expect(stateWhileInFlight).toBe(true);
    // Now reflects the server response
    expect(useDepthPreferencesStore.getState().enable_sangha).toBe(false);
  });

  it('load() failure resolves quietly and leaves the flags intact', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    mockApi.depthPreferences.get.mockRejectedValueOnce(new Error('network failure'));

    await act(async () => {
      await expect(useDepthPreferencesStore.getState().load('tok')).resolves.toBeUndefined();
    });

    const state = useDepthPreferencesStore.getState();
    // A failed read must not flip a ring — defaults remain all-on.
    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(true);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(true);
  });

  it('update() failure resolves quietly and leaves the flags intact', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    mockApi.depthPreferences.update.mockRejectedValueOnce(new Error('server error'));

    await act(async () => {
      await expect(
        useDepthPreferencesStore.getState().update({ enable_habits: false }, 'tok'),
      ).resolves.toBeUndefined();
    });

    // A failed update must not flip a ring.
    expect(useDepthPreferencesStore.getState().enable_habits).toBe(true);
  });

  it('reset() returns state to the all-on defaults', () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    act(() => {
      // Manually dirty the state to simulate a prior load
      useDepthPreferencesStore.setState({
        enable_habits: false,
        enable_practices: false,
        enable_course: false,
        enable_sangha: false,
      });
    });

    act(() => {
      useDepthPreferencesStore.getState().reset();
    });

    const state = useDepthPreferencesStore.getState();
    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(true);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(true);
  });

  it('selectors return their slices from state', () => {
    const {
      useDepthPreferencesStore,
      selectEnableHabits,
      selectEnablePractices,
      selectEnableCourse,
      selectEnableSangha,
    } = require('../useDepthPreferencesStore');

    act(() => {
      useDepthPreferencesStore.setState({
        enable_habits: true,
        enable_practices: false,
        enable_course: true,
        enable_sangha: false,
      });
    });

    const state = useDepthPreferencesStore.getState();
    expect(selectEnableHabits(state)).toBe(true);
    expect(selectEnablePractices(state)).toBe(false);
    expect(selectEnableCourse(state)).toBe(true);
    expect(selectEnableSangha(state)).toBe(false);
  });

  it('registers its reset with the shared store registry', () => {
    // Registry lets AuthContext.logout clear every store in one call
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');
    const { resetAllStores } = require('../registry');

    act(() => {
      useDepthPreferencesStore.setState({ enable_habits: false, enable_sangha: false });
    });
    expect(useDepthPreferencesStore.getState().enable_habits).toBe(false);

    act(() => resetAllStores());

    expect(useDepthPreferencesStore.getState().enable_habits).toBe(true);
    expect(useDepthPreferencesStore.getState().enable_sangha).toBe(true);
  });
});
