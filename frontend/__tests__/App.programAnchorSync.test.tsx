import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import React from 'react';

import type * as ApiModule from '../src/api';
import type { ProgramCalendar } from '../src/api';
import App from '../src/App';
import { useProgramStore } from '../src/store/useProgramStore';

/**
 * The server's anchor is adopted once a signed-in session starts (#3097).
 *
 * ``useProgramAnchorSync`` is tested on its own; this proves the app actually
 * MOUNTS it: render the real App shell for a signed-in account whose cached
 * anchor disagrees with the server, and the server's day must win. Everything
 * below the shell (the navigator and its screens) is stubbed -- what is under
 * test is the shell's own wiring, through the real reconcile and adopt.
 */

const CACHED_DAY = '2026-11-01';
/** The server's anchor, read in the account zone the mocked session reports. */
const SERVER_DAY = '2026-09-19';

const mockProgramCalendar = jest.fn<(_token?: string) => Promise<ProgramCalendar>>();
jest.mock('../src/api', () => {
  const actual = jest.requireActual<typeof ApiModule>('../src/api');
  return {
    ...actual,
    stages: {
      ...actual.stages,
      programCalendar: (token?: string) => mockProgramCalendar(token),
      setProgramStart: jest.fn(() => Promise.reject(new Error('not expected'))),
    },
  };
});

jest.mock('../src/context/AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({
    authStatus: 'authenticated',
    token: 'token',
    userTimezone: 'America/New_York',
    userTimezoneReady: true,
  }),
}));
jest.mock('../src/context/ApiKeyContext', () => ({
  ApiKeyProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../src/navigation/RootStack', () => () => null);
jest.mock('../src/features/Auth/ReauthSheet', () => ({ ReauthSheet: () => null }));
jest.mock('../src/store/useWelcomeStore', () => ({
  useFirstRun: () => ({ isFirstRun: false, markSeen: () => undefined }),
}));

const serverCalendar: ProgramCalendar = {
  // Local midnight of SERVER_DAY in New York (EDT, UTC-4).
  program_started_at: '2026-09-19T04:00:00Z',
  calendar_stage: 3,
  calendar_week: 8,
  current_stage: 3,
  cycle_number: 1,
  program_start_window: { earliest: '2026-02-20', latest: '2026-11-08' },
};

beforeEach(async () => {
  await AsyncStorage.clear();
  mockProgramCalendar.mockReset().mockResolvedValue(serverCalendar);
});

afterEach(() => {
  useProgramStore.setState({
    programStartDay: null,
    programStartDate: null,
    anchorSource: null,
    programStartWindow: null,
    programStartLocked: false,
  });
});

describe('the app shell adopts the server anchor once a session starts (#3097)', () => {
  it("replaces a cached anchor with the server's day", async () => {
    useProgramStore.getState().setProgramStartDay(CACHED_DAY);

    render(<App />);

    await waitFor(() => expect(useProgramStore.getState().anchorSource).toBe('server'));
    expect(useProgramStore.getState().programStartDay).toBe(SERVER_DAY);
    expect(mockProgramCalendar).toHaveBeenCalledTimes(1);
  });
});
