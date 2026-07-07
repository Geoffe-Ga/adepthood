import { describe, expect, it } from '@jest/globals';
import { render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { ScreenScaffold } from '../ScreenScaffold';

import { surface } from '@/design/tokens';

describe('ScreenScaffold', () => {
  it('renders children on the warm canvas ground', () => {
    const { getByText, getByTestId } = render(
      <ScreenScaffold testID="scaffold">
        <Text>hello</Text>
      </ScreenScaffold>,
    );
    expect(getByText('hello')).toBeTruthy();
    const flat = StyleSheet.flatten(getByTestId('scaffold').props.style);
    expect(flat.backgroundColor).toBe(surface.canvas);
  });

  it('renders a scroll variant', () => {
    const { getByText } = render(
      <ScreenScaffold scroll>
        <Text>scrolled</Text>
      </ScreenScaffold>,
    );
    expect(getByText('scrolled')).toBeTruthy();
  });

  it('wraps children in the shared content-capped container in the plain (non-scroll) mode', () => {
    const { getByTestId } = render(
      <ScreenScaffold>
        <Text testID="scaffold-child">hello</Text>
      </ScreenScaffold>,
    );
    const container = getByTestId('content-container');
    expect(within(container).getByTestId('scaffold-child')).toBeTruthy();
  });

  it('wraps children in the shared content-capped container in scroll mode too', () => {
    const { getByTestId } = render(
      <ScreenScaffold scroll>
        <Text testID="scaffold-scroll-child">scrolled</Text>
      </ScreenScaffold>,
    );
    const container = getByTestId('content-container');
    expect(within(container).getByTestId('scaffold-scroll-child')).toBeTruthy();
  });
});
