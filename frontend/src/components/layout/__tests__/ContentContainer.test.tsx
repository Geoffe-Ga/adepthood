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

  it('fills a phone-width screen with a grow-flexed, full-width box centered and capped at the shared content max-width', () => {
    const { getByTestId } = render(
      <ContentContainer>
        <Text>hello</Text>
      </ContentContainer>,
    );
    const flat = StyleSheet.flatten(getByTestId('content-container').props.style);
    expect(flat.flexGrow).toBe(1);
    expect(flat.flex).toBeUndefined();
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
