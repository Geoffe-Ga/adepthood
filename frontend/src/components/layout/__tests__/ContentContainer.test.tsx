/* eslint-env jest */
/* global describe, it, expect */
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { ContentContainer } from '../ContentContainer';

import { contentLayout } from '@/design/tokens';

describe('ContentContainer', () => {
  it('renders its children', () => {
    const { getByText } = render(
      <ContentContainer>
        <Text>hello</Text>
      </ContentContainer>,
    );
    expect(getByText('hello')).toBeTruthy();
  });

  it('defaults to the shared content-container testID', () => {
    const { getByTestId } = render(
      <ContentContainer>
        <Text>hello</Text>
      </ContentContainer>,
    );
    expect(getByTestId('content-container')).toBeTruthy();
  });

  it('accepts a caller-supplied testID', () => {
    const { getByTestId } = render(
      <ContentContainer testID="custom-container">
        <Text>hello</Text>
      </ContentContainer>,
    );
    expect(getByTestId('custom-container')).toBeTruthy();
  });

  it('defaults to a width-capped box with no grow of its own (content-sized, not flex-grown)', () => {
    const { getByTestId } = render(
      <ContentContainer>
        <Text>hello</Text>
      </ContentContainer>,
    );
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.flexGrow).toBeUndefined();
    expect(flat.flex).toBeUndefined();
    expect(flat.width).toBe('100%');
    expect(flat.maxWidth).toBe(contentLayout.maxWidth);
    expect(flat.alignSelf).toBe('center');
  });

  it('renders a bounded fill box (flex: 1) when the fill prop is set, keeping the width cap', () => {
    const { getByTestId } = render(
      <ContentContainer fill>
        <Text>hello</Text>
      </ContentContainer>,
    );
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.flex).toBe(1);
    expect(flat.width).toBe('100%');
    expect(flat.maxWidth).toBe(contentLayout.maxWidth);
    expect(flat.alignSelf).toBe('center');
  });

  it('merges a caller-supplied style onto the default container style without losing the cap', () => {
    const { getByTestId } = render(
      <ContentContainer style={{ backgroundColor: 'red' }}>
        <Text>hello</Text>
      </ContentContainer>,
    );
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.backgroundColor).toBe('red');
    expect(flat.maxWidth).toBe(contentLayout.maxWidth);
    expect(flat.alignSelf).toBe('center');
  });
});
