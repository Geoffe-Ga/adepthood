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

  it('initial state is all-on with loading false and error null', () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');
    const state = useDepthPreferencesStore.getState();

    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(true);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('load() sets loading true during fetch then stores returned booleans', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    const serverResponse = {
      enable_habits: true,
      enable_practices: false,
      enable_course: true,
      enable_sangha: false,
    };

    // Single mock: captures mid-flight loading state AND resolves the response
    let midFlightLoading: boolean | undefined;
    mockApi.depthPreferences.get.mockImplementationOnce(
      () =>
        new Promise<DepthPreferences>((resolve) => {
          // Record loading state synchronously before the promise settles
          midFlightLoading = useDepthPreferencesStore.getState().loading;
          resolve(serverResponse);
        }),
    );

    await act(async () => {
      await useDepthPreferencesStore.getState().load('tok');
    });

    // loading was true mid-flight
    expect(midFlightLoading).toBe(true);

    const state = useDepthPreferencesStore.getState();
    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(false);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(false);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
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

  it('load() error sets error string, restores loading to false, leaves defaults intact', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    mockApi.depthPreferences.get.mockRejectedValueOnce(new Error('network failure'));

    await act(async () => {
      await useDepthPreferencesStore.getState().load('tok');
    });

    const state = useDepthPreferencesStore.getState();
    expect(typeof state.error).toBe('string');
    expect(state.error).not.toBeNull();
    expect(state.loading).toBe(false);
    // Defaults remain all-on
    expect(state.enable_habits).toBe(true);
    expect(state.enable_practices).toBe(true);
    expect(state.enable_course).toBe(true);
    expect(state.enable_sangha).toBe(true);
  });

  it('update() error sets error string and restores loading to false', async () => {
    const { useDepthPreferencesStore } = require('../useDepthPreferencesStore');

    mockApi.depthPreferences.update.mockRejectedValueOnce(new Error('server error'));

    await act(async () => {
      await useDepthPreferencesStore.getState().update({ enable_habits: false }, 'tok');
    });

    const state = useDepthPreferencesStore.getState();
    expect(typeof state.error).toBe('string');
    expect(state.loading).toBe(false);
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
        loading: true,
        error: 'some error',
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
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it('selectors return their slices from state', () => {
    const {
      useDepthPreferencesStore,
      selectEnableHabits,
      selectEnablePractices,
      selectEnableCourse,
      selectEnableSangha,
      selectDepthPreferencesLoading,
      selectDepthPreferencesError,
    } = require('../useDepthPreferencesStore');

    act(() => {
      useDepthPreferencesStore.setState({
        enable_habits: true,
        enable_practices: false,
        enable_course: true,
        enable_sangha: false,
        loading: true,
        error: 'oops',
      });
    });

    const state = useDepthPreferencesStore.getState();
    expect(selectEnableHabits(state)).toBe(true);
    expect(selectEnablePractices(state)).toBe(false);
    expect(selectEnableCourse(state)).toBe(true);
    expect(selectEnableSangha(state)).toBe(false);
    expect(selectDepthPreferencesLoading(state)).toBe(true);
    expect(selectDepthPreferencesError(state)).toBe('oops');
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
