import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { DrawerSearchField } from '@/components/drawer';

const DEBOUNCE_MS = 300;
const TEST_ID = 'x-drawer-search';
const PLACEHOLDER = 'Search things...';
const A11Y_LABEL = 'Search things';
const DEEP_LABEL = 'Search inside things? This downloads them.';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

function renderField(bodySearchActive: boolean, resultCount?: number) {
  const onQueryChange = jest.fn();
  const onConfirmDeepSearch = jest.fn();
  const view = render(
    <DrawerSearchField
      testID={TEST_ID}
      placeholder={PLACEHOLDER}
      accessibilityLabel={A11Y_LABEL}
      deepSearchLabel={DEEP_LABEL}
      resultCount={resultCount}
      bodySearchActive={bodySearchActive}
      onQueryChange={onQueryChange}
      onConfirmDeepSearch={onConfirmDeepSearch}
    />,
  );
  return { ...view, onQueryChange, onConfirmDeepSearch };
}

function typeQuery(view: ReturnType<typeof render>, text: string): void {
  fireEvent.changeText(view.getByTestId('drawer-search-input'), text);
  act(() => {
    jest.advanceTimersByTime(DEBOUNCE_MS);
  });
}

describe('DrawerSearchField', () => {
  it('passes the testID, placeholder and accessibility label through to the field', () => {
    const view = renderField(false);
    expect(view.getByTestId(TEST_ID)).toBeTruthy();
    const input = view.getByTestId('drawer-search-input');
    expect(input.props.placeholder).toBe(PLACEHOLDER);
    expect(input.props.accessibilityLabel).toBe(A11Y_LABEL);
  });

  it('offers the deep-search row while body search is off, and confirms it once', () => {
    const view = renderField(false);
    typeQuery(view, 'ritual');
    expect(view.onQueryChange).toHaveBeenCalledWith('ritual');

    const deep = view.getByTestId('drawer-search-deep-search');
    expect(view.getByText(DEEP_LABEL)).toBeTruthy();
    fireEvent.press(deep);
    expect(view.onConfirmDeepSearch).toHaveBeenCalledTimes(1);
  });

  it('withholds the deep-search row once body search is active', () => {
    const view = renderField(true);
    typeQuery(view, 'ritual');
    expect(view.onQueryChange).toHaveBeenCalledWith('ritual');
    expect(view.queryByTestId('drawer-search-deep-search')).toBeNull();
    expect(view.queryByText(DEEP_LABEL)).toBeNull();
  });

  it('forwards the result count to the caption', () => {
    const view = renderField(true, 2);
    typeQuery(view, 'ritual');
    expect(view.getByTestId('drawer-search-result-count')).toHaveTextContent('2 results');
  });
});
