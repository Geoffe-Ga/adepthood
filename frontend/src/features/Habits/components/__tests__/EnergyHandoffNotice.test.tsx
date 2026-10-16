/**
 * A Course Energy handoff that is held for the account's habits must say so,
 * and a failed read must say what will happen and how to retry (#3328).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import EnergyHandoffNotice from '../EnergyHandoffNotice';

const NOTICE = 'energy-handoff-notice';

describe('EnergyHandoffNotice', () => {
  it('renders nothing while no handoff is held', () => {
    const view = render(
      <EnergyHandoffNotice status="idle" showRetry onRetry={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(view.queryByTestId(NOTICE)).toBeNull();
  });

  it('says the review opens once the habits have loaded, without a retry', () => {
    const onCancel = jest.fn();
    const view = render(
      <EnergyHandoffNotice status="waiting" showRetry onRetry={jest.fn()} onCancel={onCancel} />,
    );
    expect(
      view.getByText('Energy Scaffolding will open once your habits have loaded.'),
    ).toBeTruthy();
    expect(view.queryByTestId('energy-handoff-retry')).toBeNull();
    fireEvent.press(view.getByTestId('energy-handoff-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('names a failed read and offers a retry that keeps the handoff', () => {
    const onRetry = jest.fn();
    const view = render(
      <EnergyHandoffNotice status="failed" showRetry onRetry={onRetry} onCancel={jest.fn()} />,
    );
    expect(
      view.getByText(
        "We couldn't load your habits, so Energy Scaffolding hasn't opened yet. It will open once they load.",
      ),
    ).toBeTruthy();
    fireEvent.press(view.getByTestId('energy-handoff-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves the retry to the error banner when one is already offering it', () => {
    const view = render(
      <EnergyHandoffNotice
        status="failed"
        showRetry={false}
        onRetry={jest.fn()}
        onCancel={jest.fn()}
      />,
    );
    expect(view.getByTestId(NOTICE)).toBeTruthy();
    expect(view.queryByTestId('energy-handoff-retry')).toBeNull();
  });
});
