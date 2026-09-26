import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';

import { QUOTE_STRIPE_WIDTH, QuoteRow } from '../QuoteRow';

import { accent, colors, touchTarget } from '@/design/tokens';

describe('QuoteRow', () => {
  it('is one labelled button carrying the quote, its caption and the shared stripe', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(
      <QuoteRow
        text="the anger was grief"
        caption="Rain"
        onPress={onPress}
        accessibilityLabel="“the anger was grief” from Rain"
        testID="row"
      />,
    );

    const row = getByTestId('row');
    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe('“the anger was grief” from Rain');
    expect(getByText('the anger was grief')).toBeTruthy();
    expect(getByTestId('row-caption').props.children).toBe('Rain');
    const style = StyleSheet.flatten(row.props.style);
    expect(style.minHeight).toBe(touchTarget.minimum);
    expect(style.borderLeftWidth).toBe(QUOTE_STRIPE_WIDTH);
    expect(style.borderLeftColor).toBe(accent.primary);
    expect(style.backgroundColor).toBe(colors.paper.quoteHighlight);

    fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('omits the caption line when there is none, and dims a used quote', () => {
    const { getByTestId, queryByTestId } = render(
      <QuoteRow text="q" dimmed onPress={jest.fn()} accessibilityLabel="q" testID="row" />,
    );

    expect(queryByTestId('row-caption')).toBeNull();
    expect(StyleSheet.flatten(getByTestId('row').props.style).opacity).toBe(0.5);
  });

  it('renders a trailing control beside the row, never inside its press target', () => {
    const onPress = jest.fn();
    const onRemove = jest.fn();
    const { getByTestId } = render(
      <QuoteRow
        text="q"
        onPress={onPress}
        accessibilityLabel="q"
        testID="row"
        trailing={
          <TouchableOpacity testID="trailing" onPress={onRemove}>
            <Text>Remove</Text>
          </TouchableOpacity>
        }
      />,
    );

    expect(getByTestId('row').findAllByProps({ testID: 'trailing' })).toHaveLength(0);
    fireEvent.press(getByTestId('trailing'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });
});
