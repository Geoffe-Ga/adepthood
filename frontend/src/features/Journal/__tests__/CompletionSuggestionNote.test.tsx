/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import CompletionSuggestionNote from '../CompletionSuggestionNote';

import type { CheckInResult, CompletionSuggestion } from '@/api';
import { touchTarget } from '@/design/tokens';

function suggestion(overrides: Partial<CompletionSuggestion> = {}): CompletionSuggestion {
  return {
    id: 7,
    journal_entry_id: 1,
    target_type: 'habit',
    goal_id: 42,
    user_practice_id: null,
    label: 'Daily run',
    anchor_start: 0,
    anchor_end: 9,
    anchor_text: 'Daily run',
    status: 'pending',
    accepted_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

const checkIn = (streak: number): CheckInResult => ({
  streak,
  milestones: [],
  reason_code: 'streak_incremented',
});

const noop = () => Promise.resolve();

describe('CompletionSuggestionNote', () => {
  it('pending: renders the label question + OK / Not now with 44dp targets', () => {
    const { getByTestId, getByText } = render(
      <CompletionSuggestionNote
        suggestion={suggestion()}
        checkIn={null}
        onAccept={noop}
        onDismiss={noop}
      />,
    );
    expect(getByText('Daily run')).toBeTruthy();
    const ok = getByTestId('suggestion-7-accept');
    const not = getByTestId('suggestion-7-dismiss');
    expect(getByText('OK')).toBeTruthy();
    expect(getByText('Not now')).toBeTruthy();
    for (const btn of [ok, not]) {
      expect(StyleSheetMin(btn)).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
  });

  it('OK calls onAccept(id), shows "Checking…", and guards double-tap', async () => {
    let resolve: (() => void) | undefined;
    const onAccept = jest.fn(() => new Promise<void>((r) => (resolve = () => r())));
    const { getByTestId, getByText } = render(
      <CompletionSuggestionNote
        suggestion={suggestion({ id: 9 })}
        checkIn={null}
        onAccept={onAccept}
        onDismiss={noop}
      />,
    );
    fireEvent.press(getByTestId('suggestion-9-accept'));
    expect(onAccept).toHaveBeenCalledWith(9);
    expect(getByText('Checking…')).toBeTruthy();
    // Second tap while in-flight is ignored (disabled).
    fireEvent.press(getByTestId('suggestion-9-accept'));
    expect(onAccept).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve?.();
    });
  });

  it('accepted: renders the confirmation + streak from check_in', () => {
    const { getByTestId, getByText } = render(
      <CompletionSuggestionNote
        suggestion={suggestion({ status: 'accepted' })}
        checkIn={checkIn(4)}
        onAccept={noop}
        onDismiss={noop}
      />,
    );
    expect(getByTestId('suggestion-7-checked')).toBeTruthy();
    expect(getByText(/Checked off/)).toBeTruthy();
    expect(getByText(/4-day streak/)).toBeTruthy();
  });

  it('accepted practice: renders "Logged" with no streak when check_in is null (#821)', () => {
    const { getByTestId, getByText, queryByText } = render(
      <CompletionSuggestionNote
        suggestion={suggestion({ status: 'accepted', target_type: 'practice' })}
        checkIn={null}
        onAccept={noop}
        onDismiss={noop}
      />,
    );
    expect(getByTestId('suggestion-7-checked')).toBeTruthy();
    expect(getByText(/Logged/)).toBeTruthy();
    expect(queryByText(/Checked off/)).toBeNull();
    expect(queryByText(/streak/)).toBeNull();
  });

  it('Not now calls onDismiss(id)', () => {
    const onDismiss = jest.fn(() => Promise.resolve());
    const { getByTestId } = render(
      <CompletionSuggestionNote
        suggestion={suggestion({ id: 12 })}
        checkIn={null}
        onAccept={noop}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.press(getByTestId('suggestion-12-dismiss'));
    expect(onDismiss).toHaveBeenCalledWith(12);
  });

  it('dismissed: renders nothing', () => {
    const { queryByTestId } = render(
      <CompletionSuggestionNote
        suggestion={suggestion({ status: 'dismissed' })}
        checkIn={null}
        onAccept={noop}
        onDismiss={noop}
      />,
    );
    expect(queryByTestId('suggestion-7')).toBeNull();
  });
});

/** Smallest of the flattened minHeight/minWidth on a pressable, for 44dp checks. */
function StyleSheetMin(node: { props: { style: unknown } }): number {
  const { StyleSheet } = require('react-native');
  const flat = StyleSheet.flatten(node.props.style) as { minHeight?: number; minWidth?: number };
  return Math.min(flat.minHeight ?? 0, flat.minWidth ?? 0);
}
