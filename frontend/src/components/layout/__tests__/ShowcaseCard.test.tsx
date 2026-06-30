import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { ShowcaseCard } from '../ShowcaseCard';

import { showcase } from '@/design/tokens';

describe('ShowcaseCard', () => {
  it('renders children on the umber showcase band', () => {
    const { getByText, getByTestId } = render(
      <ShowcaseCard testID="showcase">
        <Text>hero</Text>
      </ShowcaseCard>,
    );
    expect(getByText('hero')).toBeTruthy();
    const flat = StyleSheet.flatten(getByTestId('showcase').props.style);
    expect(flat.backgroundColor).toBe(showcase.canvas);
    expect(flat.elevation).toBeGreaterThan(0);
  });
});
