/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import type { WritingSessionResult } from '../writingSession';
import WritingSessionBanner from '../WritingSessionBanner';

import { MS_PER_MINUTE } from '@/features/Practice/engine/types';

function result(overrides: Partial<WritingSessionResult> = {}): WritingSessionResult {
  return {
    plannedMinutes: 20,
    elapsedMs: 20 * MS_PER_MINUTE,
    elapsedMinutes: 20,
    reachedFullDuration: true,
    ...overrides,
  };
}

describe('WritingSessionBanner', () => {
  it('states what happened and offers nothing but closing it', () => {
    const { getByTestId, getByText } = render(
      <WritingSessionBanner result={result()} onDismiss={jest.fn()} />,
    );

    expect(getByText('You wrote for 20 minutes.')).toBeTruthy();
    expect(getByTestId('writing-session-banner-dismiss')).toBeTruthy();
  });

  it('announces itself once, politely, without stealing the page', () => {
    const { getByTestId } = render(
      <WritingSessionBanner result={result()} onDismiss={jest.fn()} />,
    );

    expect(getByTestId('writing-session-banner').props.accessibilityLiveRegion).toBe('polite');
  });

  it('closes in one tap', () => {
    const onDismiss = jest.fn();
    const { getByTestId } = render(
      <WritingSessionBanner result={result()} onDismiss={onDismiss} />,
    );

    fireEvent.press(getByTestId('writing-session-banner-dismiss'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders whatever a later offer hangs beneath its own sentence', () => {
    const { getByText } = render(
      <WritingSessionBanner result={result()} onDismiss={jest.fn()}>
        <Text>An offer from a later lane.</Text>
      </WritingSessionBanner>,
    );

    expect(getByText('An offer from a later lane.')).toBeTruthy();
    expect(getByText('You wrote for 20 minutes.')).toBeTruthy();
  });
});
