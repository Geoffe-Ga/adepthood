import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { SessionTimerLabel } from '../SessionTimerLabel';

import { LIGHT_SURFACE, SessionSurfaceProvider } from '@/features/Practice/views/sessionSurface';

describe('SessionTimerLabel', () => {
  it('formats 90_000ms as 01:30', () => {
    const { getByTestId } = render(<SessionTimerLabel ms={90_000} testID="timer-probe" />);
    expect(getByTestId('timer-probe').props.children).toBe('01:30');
  });

  it('formats 0ms as 00:00', () => {
    const { getByTestId } = render(<SessionTimerLabel ms={0} testID="timer-probe" />);
    expect(getByTestId('timer-probe').props.children).toBe('00:00');
  });

  it('resolves color to the light default surface text with no provider', () => {
    const { getByTestId } = render(<SessionTimerLabel ms={0} testID="timer-probe" />);
    const flattened = StyleSheet.flatten(getByTestId('timer-probe').props.style) as {
      color?: string;
    };
    expect(flattened.color).toBe(LIGHT_SURFACE.text);
  });

  it('resolves color to the provided surface text', () => {
    const customSurface = { ...LIGHT_SURFACE, text: '#654321' };
    const { getByTestId } = render(
      <SessionSurfaceProvider value={customSurface}>
        <SessionTimerLabel ms={0} testID="timer-probe" />
      </SessionSurfaceProvider>,
    );
    const flattened = StyleSheet.flatten(getByTestId('timer-probe').props.style) as {
      color?: string;
    };
    expect(flattened.color).toBe('#654321');
  });
});
