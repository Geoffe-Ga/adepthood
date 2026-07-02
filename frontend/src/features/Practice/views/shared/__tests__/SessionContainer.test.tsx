import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { SessionContainer } from '../SessionContainer';

import { SPACING } from '@/design/tokens';
import { LIGHT_SURFACE, SessionSurfaceProvider } from '@/features/Practice/views/sessionSurface';

describe('SessionContainer', () => {
  it('renders its children', () => {
    const { getByText } = render(
      <SessionContainer testID="session-container-probe">
        <Text>probe child</Text>
      </SessionContainer>,
    );
    expect(getByText('probe child')).toBeTruthy();
  });

  it('resolves backgroundColor to the light default surface ground with no provider', () => {
    const { getByTestId } = render(
      <SessionContainer testID="session-container-probe">
        <Text>x</Text>
      </SessionContainer>,
    );
    const flattened = StyleSheet.flatten(getByTestId('session-container-probe').props.style) as {
      backgroundColor?: string;
    };
    expect(flattened.backgroundColor).toBe(LIGHT_SURFACE.ground);
  });

  it('resolves backgroundColor to the provided surface ground', () => {
    const customSurface = { ...LIGHT_SURFACE, ground: '#123456' };
    const { getByTestId } = render(
      <SessionSurfaceProvider value={customSurface}>
        <SessionContainer testID="session-container-probe">
          <Text>x</Text>
        </SessionContainer>
      </SessionSurfaceProvider>,
    );
    const flattened = StyleSheet.flatten(getByTestId('session-container-probe').props.style) as {
      backgroundColor?: string;
    };
    expect(flattened.backgroundColor).toBe('#123456');
  });

  it('centers children with the xl spacing padding', () => {
    const { getByTestId } = render(
      <SessionContainer testID="session-container-probe">
        <Text>x</Text>
      </SessionContainer>,
    );
    const flattened = StyleSheet.flatten(getByTestId('session-container-probe').props.style) as {
      alignItems?: string;
      padding?: number;
    };
    expect(flattened.alignItems).toBe('center');
    expect(flattened.padding).toBe(SPACING.xl);
  });

  it('merges a style override while keeping the surface ground', () => {
    const customSurface = { ...LIGHT_SURFACE, ground: '#abcdef' };
    const { getByTestId } = render(
      <SessionSurfaceProvider value={customSurface}>
        <SessionContainer testID="session-container-probe" style={{ flex: 1 }}>
          <Text>x</Text>
        </SessionContainer>
      </SessionSurfaceProvider>,
    );
    const flattened = StyleSheet.flatten(getByTestId('session-container-probe').props.style) as {
      backgroundColor?: string;
      flex?: number;
    };
    expect(flattened.flex).toBe(1);
    expect(flattened.backgroundColor).toBe('#abcdef');
  });
});
