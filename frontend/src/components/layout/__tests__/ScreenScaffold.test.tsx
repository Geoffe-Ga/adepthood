import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
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
});
