import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { CalloutBand } from '../CalloutBand';

import { accent, surface, touchTarget } from '@/design/tokens';

describe('CalloutBand', () => {
  it('renders the label on the accent band and fires onPress', () => {
    const onPress = jest.fn();
    const { getByText, getByTestId } = render(
      <CalloutBand label="Begin" onPress={onPress} testID="callout" />,
    );
    fireEvent.press(getByText('Begin'));
    expect(onPress).toHaveBeenCalledTimes(1);
    const flat = StyleSheet.flatten(getByTestId('callout').props.style);
    expect(flat.backgroundColor).toBe(accent.primary);
    expect(flat.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('renders the CTA label in inverted cream', () => {
    const { getByText } = render(<CalloutBand label="Begin" onPress={jest.fn()} />);
    const flat = StyleSheet.flatten(getByText('Begin').props.style);
    expect(flat.color).toBe(surface.canvas);
  });
});
