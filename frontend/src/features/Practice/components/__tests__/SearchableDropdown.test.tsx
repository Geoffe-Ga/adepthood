import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import SearchableDropdown, {
  DropdownEmptyState,
  DropdownGroupHeader,
  DropdownOptionRow,
} from '../SearchableDropdown';

function renderShell(
  overrides: Partial<React.ComponentProps<typeof SearchableDropdown>> = {},
): ReturnType<typeof render> {
  return render(
    <SearchableDropdown
      testID="dd"
      triggerTestID="dd-trigger"
      panelTestID="dd-panel"
      searchTestID="dd-search"
      triggerLabel="Pick one"
      placeholder="Search…"
      searchAccessibilityLabel="Search options"
      open={false}
      query=""
      onToggle={jest.fn()}
      onQueryChange={jest.fn()}
      {...overrides}
    >
      <DropdownGroupHeader label="Group" />
      <DropdownOptionRow
        label="Option A"
        caption="caption a"
        onPress={jest.fn()}
        testID="dd-option-a"
        accessibilityLabel="Option A"
      />
    </SearchableDropdown>,
  );
}

describe('SearchableDropdown', () => {
  it('renders the trigger label and stays collapsed when closed', () => {
    const { getByTestId, queryByTestId } = renderShell();
    expect(getByTestId('dd-trigger')).toBeTruthy();
    expect(queryByTestId('dd-panel')).toBeNull();
  });

  it('shows an optional badge on the trigger', () => {
    const { getByTestId } = renderShell({ badge: { text: 'Sight', testID: 'dd-badge' } });
    expect(getByTestId('dd-badge')).toHaveTextContent('Sight');
  });

  it('fires onToggle when the trigger is pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = renderShell({ onToggle });
    fireEvent.press(getByTestId('dd-trigger'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('reveals the search box, create slot and results when open', () => {
    const onQueryChange = jest.fn();
    const { getByTestId } = renderShell({
      open: true,
      onQueryChange,
      createSlot: <DropdownGroupHeader label="Create" />,
    });
    expect(getByTestId('dd-panel')).toBeTruthy();
    expect(getByTestId('dd-option-a')).toBeTruthy();
    fireEvent.changeText(getByTestId('dd-search'), 'abc');
    expect(onQueryChange).toHaveBeenCalledWith('abc');
  });

  it('labels the search field for screen readers', () => {
    const { getByTestId } = renderShell({ open: true, searchAccessibilityLabel: 'Search tags' });
    expect(getByTestId('dd-search').props.accessibilityLabel).toBe('Search tags');
  });

  it('exposes an empty-state helper with a handle', () => {
    const { getByTestId } = render(<DropdownEmptyState label="Nothing" testID="dd-empty" />);
    expect(getByTestId('dd-empty')).toHaveTextContent('Nothing');
  });

  it('marks a selected option row', () => {
    const { getByTestId } = render(
      <DropdownOptionRow
        label="Sel"
        onPress={jest.fn()}
        testID="dd-sel"
        accessibilityLabel="Sel"
        selected
      />,
    );
    expect(getByTestId('dd-sel').props.accessibilityState.selected).toBe(true);
  });
});
