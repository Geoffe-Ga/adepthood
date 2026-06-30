/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import ConfiguratorBody from '../ConfiguratorBody';

import { defaultConfigFor } from '@/features/Practice/configurator/defaults';
import type { ModeConfig } from '@/features/Practice/engine/types';

const noop = (): void => {};
const fallback = (mode: string): React.JSX.Element => <Text testID="fallback">{mode}</Text>;

describe('ConfiguratorBody dispatcher', () => {
  it('renders the meditation-timer form for a timer-family mode', () => {
    const config = defaultConfigFor('meditation_timer');
    const { getByTestId } = render(
      <ConfiguratorBody config={config} onChange={noop} renderFallback={fallback} />,
    );
    expect(getByTestId('meditation-timer-form')).toBeTruthy();
  });

  it('renders the tallied-grounding form for a grounding-family mode', () => {
    const config = defaultConfigFor('tallied_grounding');
    const { getByTestId } = render(
      <ConfiguratorBody config={config} onChange={noop} renderFallback={fallback} />,
    );
    expect(getByTestId('tallied-grounding-form')).toBeTruthy();
  });

  it('renders the consumer fallback (with the mode name) for an unknown mode', () => {
    const unknown = { mode: 'mystery' } as unknown as ModeConfig;
    const { getByTestId } = render(
      <ConfiguratorBody config={unknown} onChange={noop} renderFallback={fallback} />,
    );
    expect(getByTestId('fallback').props.children).toBe('mystery');
  });
});
