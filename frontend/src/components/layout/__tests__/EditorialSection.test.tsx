import { describe, expect, it } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { EditorialSection } from '../EditorialSection';

import { rhythm } from '@/design/tokens';

describe('EditorialSection', () => {
  it('renders its title + children separated by the section gap', () => {
    const { getByText, getByTestId } = render(
      <EditorialSection title="Recent" testID="section">
        <Text>item</Text>
      </EditorialSection>,
    );
    expect(getByText('Recent')).toBeTruthy();
    expect(getByText('item')).toBeTruthy();
    const flat = StyleSheet.flatten(getByTestId('section').props.style);
    expect(flat.marginTop).toBe(rhythm.sectionGap);
  });

  it('renders untitled with just children', () => {
    const { getByText, queryByText } = render(
      <EditorialSection>
        <Text>only</Text>
      </EditorialSection>,
    );
    expect(getByText('only')).toBeTruthy();
    expect(queryByText('Recent')).toBeNull();
  });
});
