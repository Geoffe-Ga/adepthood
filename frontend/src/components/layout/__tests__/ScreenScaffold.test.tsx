import { describe, expect, it } from '@jest/globals';
import { render, within } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { ScreenScaffold } from '../ScreenScaffold';

import { rhythm, surface } from '@/design/tokens';

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

  it('grows the scroll contentContainerStyle to fill the viewport while keeping screen padding', () => {
    const { getByTestId } = render(
      <ScreenScaffold scroll testID="scaffold">
        <Text>x</Text>
      </ScreenScaffold>,
    );
    const flat = StyleSheet.flatten(getByTestId('scaffold').props.contentContainerStyle);
    expect(flat.flexGrow).toBe(1);
    expect(flat.paddingHorizontal).toBe(rhythm.screenPaddingH);
    expect(flat.paddingTop).toBe(rhythm.screenPaddingTop);
  });

  it('keeps the scroll contentContainerStyle as a single grow, not a bounded flex box', () => {
    const { getByTestId } = render(
      <ScreenScaffold scroll testID="scaffold">
        <Text>x</Text>
      </ScreenScaffold>,
    );
    const flat = StyleSheet.flatten(getByTestId('scaffold').props.contentContainerStyle);
    expect(flat.flexGrow).toBe(1);
    expect(flat.flex).toBeUndefined();
    expect(flat.flexShrink).toBeUndefined();
  });

  it('lets a caller style win over the default scroll contentContainerStyle', () => {
    const { getByTestId } = render(
      <ScreenScaffold scroll testID="scaffold" style={{ paddingTop: 999 }}>
        <Text>x</Text>
      </ScreenScaffold>,
    );
    const flat = StyleSheet.flatten(getByTestId('scaffold').props.contentContainerStyle);
    expect(flat.paddingTop).toBe(999);
  });

  it('keeps the inner content container content-sized (non-growing) inside the scroll variant', () => {
    const { getByTestId } = render(
      <ScreenScaffold scroll>
        <Text>x</Text>
      </ScreenScaffold>,
    );
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.flexGrow).toBeUndefined();
    expect(flat.flex).toBeUndefined();
  });

  it('gives the inner content container a bounded fill in the non-scroll variant', () => {
    const { getByTestId } = render(
      <ScreenScaffold>
        <Text>x</Text>
      </ScreenScaffold>,
    );
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.flex).toBe(1);
  });

  it('keeps the non-scroll root fill-flexed with screen padding', () => {
    const { getByTestId } = render(
      <ScreenScaffold testID="scaffold-plain">
        <Text>x</Text>
      </ScreenScaffold>,
    );
    const flat = StyleSheet.flatten(getByTestId('scaffold-plain').props.style);
    expect(flat.flex).toBe(1);
    expect(flat.paddingHorizontal).toBe(rhythm.screenPaddingH);
    expect(flat.paddingTop).toBe(rhythm.screenPaddingTop);
  });
});
