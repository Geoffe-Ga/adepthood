import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

const mockRootNavigate = jest.fn();
// The drawer now dispatches through the root stack, not the tab navigator.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: mockRootNavigate }),
}));

import DrawerNavSection from '@/components/drawer/DrawerNavSection';
import { surface } from '@/design/tokens';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

beforeEach(() => {
  jest.clearAllMocks();
  useDepthPreferencesStore.setState({
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
  });
});

describe('DrawerNavSection', () => {
  it('renders exactly five rows when every ring is on', () => {
    const onNavigate = jest.fn();
    const { getByTestId } = render(
      <DrawerNavSection currentScreen="Journal" onNavigate={onNavigate} />,
    );

    expect(getByTestId('drawer-nav-Journal')).toBeTruthy();
    expect(getByTestId('drawer-nav-Habits')).toBeTruthy();
    expect(getByTestId('drawer-nav-Practice')).toBeTruthy();
    expect(getByTestId('drawer-nav-Course')).toBeTruthy();
    expect(getByTestId('drawer-nav-Map')).toBeTruthy();
  });

  it('hides the Habits row when the habits ring is off, keeping the rest', () => {
    useDepthPreferencesStore.setState({ enable_habits: false });
    const onNavigate = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <DrawerNavSection currentScreen="Journal" onNavigate={onNavigate} />,
    );

    expect(queryByTestId('drawer-nav-Habits')).toBeNull();
    expect(getByTestId('drawer-nav-Journal')).toBeTruthy();
    expect(getByTestId('drawer-nav-Practice')).toBeTruthy();
    expect(getByTestId('drawer-nav-Course')).toBeTruthy();
    expect(getByTestId('drawer-nav-Map')).toBeTruthy();
  });

  it('renders only Journal and Map when every gated ring is off', () => {
    useDepthPreferencesStore.setState({
      enable_habits: false,
      enable_practices: false,
      enable_course: false,
    });
    const onNavigate = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <DrawerNavSection currentScreen="Journal" onNavigate={onNavigate} />,
    );

    expect(getByTestId('drawer-nav-Journal')).toBeTruthy();
    expect(getByTestId('drawer-nav-Map')).toBeTruthy();
    expect(queryByTestId('drawer-nav-Habits')).toBeNull();
    expect(queryByTestId('drawer-nav-Practice')).toBeNull();
    expect(queryByTestId('drawer-nav-Course')).toBeNull();
  });

  it('drops the Course row live when the course ring flips off without a re-render', () => {
    const onNavigate = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <DrawerNavSection currentScreen="Journal" onNavigate={onNavigate} />,
    );

    expect(getByTestId('drawer-nav-Course')).toBeTruthy();

    act(() => {
      useDepthPreferencesStore.setState({ enable_course: false });
    });

    expect(queryByTestId('drawer-nav-Course')).toBeNull();
  });

  it('marks only the current screen row as selected', () => {
    const onNavigate = jest.fn();
    const { getByTestId } = render(
      <DrawerNavSection currentScreen="Habits" onNavigate={onNavigate} />,
    );

    expect(getByTestId('drawer-nav-Habits').props.accessibilityState.selected).toBe(true);
    expect(getByTestId('drawer-nav-Journal').props.accessibilityState.selected).toBe(false);
  });

  it('navigates to a non-current row and calls onNavigate', () => {
    const onNavigate = jest.fn();
    const { getByTestId } = render(
      <DrawerNavSection currentScreen="Habits" onNavigate={onNavigate} />,
    );

    fireEvent.press(getByTestId('drawer-nav-Journal'));

    expect(mockRootNavigate).toHaveBeenCalledTimes(1);
    expect(mockRootNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Journal' });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('still navigates and calls onNavigate when the current row is pressed', () => {
    const onNavigate = jest.fn();
    const { getByTestId } = render(
      <DrawerNavSection currentScreen="Habits" onNavigate={onNavigate} />,
    );

    fireEvent.press(getByTestId('drawer-nav-Habits'));

    expect(mockRootNavigate).toHaveBeenCalledWith('Tabs', { screen: 'Habits' });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('renders a hairline divider below the rows', () => {
    const onNavigate = jest.fn();
    const { getByTestId } = render(
      <DrawerNavSection currentScreen="Journal" onNavigate={onNavigate} />,
    );

    const divider = getByTestId('drawer-nav-divider');
    const flatStyle = StyleSheet.flatten(divider.props.style) as {
      height?: number;
      backgroundColor?: string;
    };
    expect(flatStyle.height).toBe(StyleSheet.hairlineWidth);
    expect(flatStyle.backgroundColor).toBe(surface.hairline);
  });
});
