/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import PracticeCatalogSwitcher from '../PracticeCatalogSwitcher';

import { onShowcase } from '@/design/tokens';

type SwitcherTab = 'practice' | 'catalog';

const noopChange = jest.fn() as unknown as (tab: SwitcherTab) => void;

describe('PracticeCatalogSwitcher', () => {
  it('renders a centered tablist with Practice and Catalog text tabs', () => {
    const { getByTestId } = render(
      <PracticeCatalogSwitcher active="practice" onChange={noopChange} />,
    );

    const switcher = getByTestId('practice-tab-switcher');
    expect(switcher.props.accessibilityRole).toBe('tablist');
    const practiceTab = getByTestId('practice-tab-practice');
    const catalogTab = getByTestId('practice-tab-catalog');
    expect(practiceTab.props.accessibilityRole).toBe('tab');
    expect(catalogTab.props.accessibilityRole).toBe('tab');
    expect(within(practiceTab).getByText('Practice')).toBeTruthy();
    expect(within(catalogTab).getByText('Catalog')).toBeTruthy();
  });

  it('marks the active tab selected in onShowcase.primary and the inactive tab muted', () => {
    const { getByTestId } = render(
      <PracticeCatalogSwitcher active="practice" onChange={noopChange} />,
    );

    const practiceTab = getByTestId('practice-tab-practice');
    const catalogTab = getByTestId('practice-tab-catalog');
    expect(practiceTab.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(catalogTab.props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
    const activeText = StyleSheet.flatten(within(practiceTab).getByText('Practice').props.style);
    const inactiveText = StyleSheet.flatten(within(catalogTab).getByText('Catalog').props.style);
    expect(activeText.color).toBe(onShowcase.primary);
    expect(inactiveText.color).toBe(onShowcase.muted);
  });

  it('underlines only the active tab', () => {
    const { getByTestId } = render(
      <PracticeCatalogSwitcher active="catalog" onChange={noopChange} />,
    );

    const activeFlat = StyleSheet.flatten(getByTestId('practice-tab-catalog').props.style);
    const inactiveFlat = StyleSheet.flatten(getByTestId('practice-tab-practice').props.style);
    expect(activeFlat.borderBottomWidth).toBeGreaterThan(0);
    expect(activeFlat.borderBottomColor).toBe(onShowcase.primary);
    expect(inactiveFlat.borderBottomColor).not.toBe(onShowcase.primary);
  });

  it('mirrors the selected state when Catalog is the active tab', () => {
    const { getByTestId } = render(
      <PracticeCatalogSwitcher active="catalog" onChange={noopChange} />,
    );

    expect(getByTestId('practice-tab-catalog').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(getByTestId('practice-tab-practice').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('reports tab presses through onChange with the tab id', () => {
    const onChange = jest.fn() as unknown as (tab: SwitcherTab) => void;
    const { getByTestId } = render(
      <PracticeCatalogSwitcher active="practice" onChange={onChange} />,
    );

    fireEvent.press(getByTestId('practice-tab-catalog'));
    expect(onChange).toHaveBeenCalledWith('catalog');
    fireEvent.press(getByTestId('practice-tab-practice'));
    expect(onChange).toHaveBeenCalledWith('practice');
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
