/* eslint-env jest */
// RED coverage for the shared DrawerNavSection wired into the Journal header
// drawer. The nav rows do not exist yet in JournalScreenDrawer -- these
// assertions pin the missing wiring so the implementation step has a target.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { JournalScreenDrawer } from '../JournalDrawer';

import type { JournalListResponse } from '@/api';
import { type ScreenDrawerState } from '@/components/drawer';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

const mockList = jest.fn() as jest.MockedFunction<
  (_p?: { search?: string; limit?: number; offset?: number }) => Promise<JournalListResponse>
>;
const mockNavigate = jest.fn();
const mockClose = jest.fn();

jest.mock('@/api', () => ({
  journal: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  useAppNavigation: () => ({ navigate: mockNavigate, setOptions: jest.fn() }),
}));

function fakeDrawer(): ScreenDrawerState {
  return { isOpen: true, open: jest.fn(), close: mockClose };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue({ items: [], total: 0, has_more: false });
  useDepthPreferencesStore.setState({
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
  });
});

describe('Journal header drawer nav section', () => {
  it('renders the nav section before the New entry row, with a trailing divider', async () => {
    const { getByTestId, toJSON } = render(
      <JournalScreenDrawer
        drawer={fakeDrawer()}
        currentEntryId={null}
        onSelectEntry={jest.fn()}
        onNewEntry={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    expect(getByTestId('journal-drawer-new-entry')).toBeTruthy();

    expect(getByTestId('drawer-nav-Journal')).toBeTruthy();
    expect(getByTestId('drawer-nav-divider')).toBeTruthy();

    const json = JSON.stringify(toJSON());
    const navIndex = json.indexOf('"testID":"drawer-nav-Journal"');
    const newEntryIndex = json.indexOf('"testID":"journal-drawer-new-entry"');
    expect(navIndex).toBeGreaterThan(-1);
    expect(navIndex).toBeLessThan(newEntryIndex);
  });

  it('marks the Journal nav row selected', async () => {
    const { getByTestId } = render(
      <JournalScreenDrawer
        drawer={fakeDrawer()}
        currentEntryId={null}
        onSelectEntry={jest.fn()}
        onNewEntry={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    expect(getByTestId('drawer-nav-Journal').props.accessibilityState.selected).toBe(true);
  });

  it('navigating to a different screen from the nav section closes the drawer', async () => {
    const { getByTestId } = render(
      <JournalScreenDrawer
        drawer={fakeDrawer()}
        currentEntryId={null}
        onSelectEntry={jest.fn()}
        onNewEntry={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    fireEvent.press(getByTestId('drawer-nav-Map'));

    expect(mockNavigate).toHaveBeenCalledWith('Map');
    expect(mockClose).toHaveBeenCalled();
  });

  it('hides the Habits nav row while its depth ring is disabled, keeping the others visible', async () => {
    useDepthPreferencesStore.setState({ enable_habits: false });
    const { getByTestId, queryByTestId } = render(
      <JournalScreenDrawer
        drawer={fakeDrawer()}
        currentEntryId={null}
        onSelectEntry={jest.fn()}
        onNewEntry={jest.fn()}
      />,
    );
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    expect(getByTestId('drawer-nav-Journal')).toBeTruthy();
    expect(queryByTestId('drawer-nav-Habits')).toBeNull();
    expect(getByTestId('drawer-nav-Map')).toBeTruthy();
  });
});
