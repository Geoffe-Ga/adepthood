import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import {
  SWEEP_RETRY_LABEL,
  SearchSweepStatus,
  sweepStatusFrom,
  type SweepStatus,
} from '@/components/drawer';
import { accent, ink } from '@/design/tokens';

const PREFIX = 'x-drawer-search';
const LOADING = 'Searching inside things...';
const ERROR = 'We could not finish searching the things.';

function renderStatus(active: boolean, status: SweepStatus, onRetry = jest.fn()) {
  const view = render(
    <SearchSweepStatus
      active={active}
      status={status}
      onRetry={onRetry}
      testIDPrefix={PREFIX}
      loadingLabel={LOADING}
      errorLabel={ERROR}
    />,
  );
  return { ...view, onRetry };
}

describe('SearchSweepStatus', () => {
  it('renders the loading row, and the error row whose retry calls onRetry, from a single status prop', () => {
    const onRetry = jest.fn();
    const view = renderStatus(true, 'loading', onRetry);
    expect(view.getByTestId(`${PREFIX}-loading`)).toBeTruthy();
    expect(view.getByText(LOADING)).toBeTruthy();
    expect(view.queryByTestId(`${PREFIX}-error`)).toBeNull();

    view.rerender(
      <SearchSweepStatus
        active
        status="error"
        onRetry={onRetry}
        testIDPrefix={PREFIX}
        loadingLabel={LOADING}
        errorLabel={ERROR}
      />,
    );
    expect(view.getByTestId(`${PREFIX}-error`)).toBeTruthy();
    expect(view.getByText(ERROR)).toBeTruthy();
    expect(view.getByText('Tap to retry')).toBeTruthy();
    expect(view.queryByTestId(`${PREFIX}-loading`)).toBeNull();
    expect(onRetry).not.toHaveBeenCalled();

    fireEvent.press(view.getByTestId(`${PREFIX}-retry`));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while the deep search is inactive, whatever the status', () => {
    for (const status of ['idle', 'loading', 'error'] as const) {
      const view = renderStatus(false, status);
      expect(view.toJSON()).toBeNull();
      view.unmount();
    }
  });

  it('renders nothing for an active but idle sweep', () => {
    const view = renderStatus(true, 'idle');
    expect(view.toJSON()).toBeNull();
  });

  it('pairs the loading row with an accent spinner and a muted caption', () => {
    const view = renderStatus(true, 'loading');
    const row = view.getByTestId(`${PREFIX}-loading`);
    expect(StyleSheet.flatten(row.props.style)).toMatchObject({ flexDirection: 'row' });
    expect(view.UNSAFE_getByType(ActivityIndicator).props).toMatchObject({
      size: 'small',
      color: accent.primary,
    });
    expect(StyleSheet.flatten(view.getByText(LOADING).props.style).color).toBe(ink.muted);
  });

  it('labels the retry with the shared copy', () => {
    expect(SWEEP_RETRY_LABEL).toBe('Tap to retry');
    const view = renderStatus(true, 'error');
    expect(view.getByTestId(`${PREFIX}-retry`)).toHaveTextContent(SWEEP_RETRY_LABEL);
  });
});

describe('sweepStatusFrom', () => {
  const table: [boolean, boolean, SweepStatus][] = [
    [false, false, 'idle'],
    [true, false, 'loading'],
    [false, true, 'error'],
    [true, true, 'loading'],
  ];
  it.each(table)('loading=%s error=%s -> %s', (loading, error, expected) => {
    expect(sweepStatusFrom(loading, error)).toBe(expected);
  });
});
