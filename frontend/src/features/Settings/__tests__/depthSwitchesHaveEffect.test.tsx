/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

/**
 * Every switch under "Choose your depths" must have a visible destination.
 *
 * "Destination" rather than "navigation" on purpose: the Sangha is Discord by
 * design (NORTH-STAR names the Digital Sangha as a community that lives there,
 * and ``SanghaSection`` forbids any Sangha surface outside Settings), so its
 * destination is a door in Settings, not a drawer row or tab. Habits, Practice
 * and Course each own a primary destination the drawer lists.
 *
 * The depth-preferences store is REAL here while every sibling test mocks it,
 * because the point is the wire from switch to destination: a switch flips,
 * the store takes the server's echoed snapshot, and the destination it governs
 * appears or disappears. A switch that dispatches correctly to a store nothing
 * reads would pass every unit test and still be a dead control — the exact
 * defect this file exists to keep out.
 */

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

const TOKEN = 'depth-effect-token';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ logout: jest.fn(), token: TOKEN }),
}));

jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: () => Promise.resolve(true),
}));

// Everything else in config stays real: the store reaches the API client,
// which reads API_BASE_URL. `defineProperty` rather than a literal getter so
// Babel's object-spread helper does not freeze the value on first require.
const INVITE_URL = 'https://discord.gg/depth-effect-sangha';

jest.mock('@/config', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/config');
  return Object.defineProperty({ ...actual }, 'SANGHA_INVITE_URL', {
    enumerable: true,
    get: (): string => INVITE_URL,
  });
});

/** Every ring on: the store's own default and the state each test starts from. */
const ALL_ON: DepthPreferences = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

// The fake server. Read lazily inside the jest.fn bodies, never in the mock
// factory, and echoing the FULL snapshot because the store keeps only what the
// server echoes back.
let mockCurrent: DepthPreferences = ALL_ON;

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    depthPreferences: {
      get: jest.fn(() => Promise.resolve({ ...mockCurrent })),
      update: jest.fn((partial: Partial<DepthPreferences>) => {
        mockCurrent = { ...mockCurrent, ...partial };
        return Promise.resolve({ ...mockCurrent });
      }),
    },
  };
});

import ChooseDepthsSection from '../ChooseDepthsSection';
import SettingsHubScreen from '../SettingsHubScreen';

import { depthPreferences } from '@/api';
import type { DepthPreferences } from '@/api';
import DrawerNavSection from '@/components/drawer/DrawerNavSection';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

/** Each switch under Choose-your-depths, and the destination it governs. */
const DESTINATION_BY_SWITCH: ReadonlyMap<string, string> = new Map([
  ['depth-toggle-habits', 'drawer-nav-Habits'],
  ['depth-toggle-practices', 'drawer-nav-Practice'],
  ['depth-toggle-course', 'drawer-nav-Course'],
  ['depth-toggle-sangha', 'settings-group-sangha'],
]);

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrent = ALL_ON;
  useDepthPreferencesStore.setState({ ...ALL_ON });
});

describe('the Sangha switch and the Digital Sangha door', () => {
  it('turning Sangha off closes the door, and turning it back on reopens it', async () => {
    const { getByTestId, queryByTestId } = render(<SettingsHubScreen />);

    expect(getByTestId('settings-group-sangha')).toBeTruthy();
    expect(getByTestId('settings-row-sangha-discord')).toBeTruthy();

    fireEvent(getByTestId('depth-toggle-sangha'), 'valueChange', false);

    await waitFor(() => {
      expect(queryByTestId('settings-group-sangha')).toBeNull();
    });
    expect(queryByTestId('settings-row-sangha-discord')).toBeNull();

    fireEvent(getByTestId('depth-toggle-sangha'), 'valueChange', true);

    await waitFor(() => {
      expect(queryByTestId('settings-group-sangha')).toBeTruthy();
    });
    expect(queryByTestId('settings-row-sangha-discord')).toBeTruthy();

    expect(depthPreferences.update).toHaveBeenNthCalledWith(1, { enable_sangha: false }, TOKEN);
    expect(depthPreferences.update).toHaveBeenNthCalledWith(2, { enable_sangha: true }, TOKEN);
  });
});

describe('the ring switches and their drawer rows', () => {
  it.each([
    ['habits', 'Habits'],
    ['practices', 'Practice'],
    ['course', 'Course'],
  ])('turning %s off removes the %s drawer row while Journal and Map remain', async (ring, row) => {
    const { getByTestId, queryByTestId } = render(
      <>
        <ChooseDepthsSection />
        <DrawerNavSection currentScreen="Journal" onNavigate={jest.fn()} />
      </>,
    );

    expect(getByTestId(`drawer-nav-${row}`)).toBeTruthy();

    fireEvent(getByTestId(`depth-toggle-${ring}`), 'valueChange', false);

    await waitFor(() => {
      expect(queryByTestId(`drawer-nav-${row}`)).toBeNull();
    });
    expect(getByTestId('drawer-nav-Journal')).toBeTruthy();
    expect(getByTestId('drawer-nav-Map')).toBeTruthy();

    fireEvent(getByTestId(`depth-toggle-${ring}`), 'valueChange', true);

    await waitFor(() => {
      expect(queryByTestId(`drawer-nav-${row}`)).toBeTruthy();
    });
  });
});

describe('every switch under Choose your depths', () => {
  it('maps to a destination — an unmapped switch is a dead control', () => {
    const { getByTestId } = render(<SettingsHubScreen />);

    const switches = within(getByTestId('settings-group-depths')).getAllByRole('switch');

    for (const sw of switches) {
      const testID = sw.props.testID as string;
      expect(DESTINATION_BY_SWITCH.has(testID)).toBe(true);
    }
    expect(switches).toHaveLength(DESTINATION_BY_SWITCH.size);
  });
});
