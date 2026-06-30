/* eslint-env jest */
/* global describe, it, expect */
import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ThemeProvider, useTheme } from '../ThemeContext';
import { surface, surfaceDark } from '../tokens';

const Probe = (): React.JSX.Element => {
  const { mode, surface: s } = useTheme();
  return <Text testID="probe">{`${mode}:${s.canvas}`}</Text>;
};

describe('useTheme / ThemeProvider (#804)', () => {
  it('resolves the light token set when rendered without a provider', () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').props.children).toBe(`light:${surface.canvas}`);
  });

  it('resolves the dark token set under ThemeProvider initialMode="dark"', () => {
    const { getByTestId } = render(
      <ThemeProvider initialMode="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('probe').props.children).toBe(`dark:${surfaceDark.canvas}`);
  });

  it('honours an explicit light initialMode', () => {
    const { getByTestId } = render(
      <ThemeProvider initialMode="light">
        <Probe />
      </ThemeProvider>,
    );
    expect(getByTestId('probe').props.children).toBe(`light:${surface.canvas}`);
  });
});
