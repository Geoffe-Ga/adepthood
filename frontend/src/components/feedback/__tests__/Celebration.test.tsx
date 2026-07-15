/* eslint-env jest */
import { jest, describe, it, expect, afterEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Animated, Text } from 'react-native';

import { Celebration } from '@/components/feedback/Celebration';
import * as reducedMotion from '@/hooks/useReducedMotion';

const DISMISS_MS = 2400;

describe('Celebration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders its children', () => {
    const { getByText } = render(
      <Celebration active={false}>
        <Text>Goal reached</Text>
      </Celebration>,
    );
    expect(getByText('Goal reached')).toBeTruthy();
  });

  it('plays the scale pulse once when active with motion allowed', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);
    const start = jest.fn();
    const sequence = jest
      .spyOn(Animated, 'sequence')
      .mockReturnValue({ start } as unknown as Animated.CompositeAnimation);
    render(
      <Celebration active>
        <Text>Milestone</Text>
      </Celebration>,
    );
    expect(sequence).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('auto-dismisses after the window when active', () => {
    jest.useFakeTimers();
    const onDismiss = jest.fn();
    render(
      <Celebration active onDismiss={onDismiss}>
        <Text>Done</Text>
      </Celebration>,
    );
    expect(onDismiss).not.toHaveBeenCalled();
    jest.advanceTimersByTime(DISMISS_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('skips the pulse but still auto-dismisses under reduced motion', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);
    const sequence = jest.spyOn(Animated, 'sequence');
    jest.useFakeTimers();
    const onDismiss = jest.fn();
    const { getByText } = render(
      <Celebration active onDismiss={onDismiss}>
        <Text>Quiet win</Text>
      </Celebration>,
    );
    expect(getByText('Quiet win')).toBeTruthy();
    expect(sequence).not.toHaveBeenCalled();
    jest.advanceTimersByTime(DISMISS_MS);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
