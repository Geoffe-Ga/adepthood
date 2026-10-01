import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { Check } from 'lucide-react-native';
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';

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

  it('marks a folded-in quote with an accent check glyph that assistive tech skips (#2952)', () => {
    const { getByTestId, queryByTestId, UNSAFE_getByType } = render(
      <QuoteRow text="q" dimmed marked onPress={jest.fn()} accessibilityLabel="q" testID="row" />,
    );

    // Present in the tree, absent from the accessibility tree: the row's own
    // label and state carry the meaning, the glyph only draws it.
    expect(getByTestId('row-check', { includeHiddenElements: true })).toBeTruthy();
    expect(queryByTestId('row-check')).toBeNull();
    // react-native-web reads only aria-hidden, so the web reader skips it too (#3009).
    expect(getByTestId('row-check', { includeHiddenElements: true }).props['aria-hidden']).toBe(
      true,
    );
    const glyph = UNSAFE_getByType(Check);
    expect(glyph.props.color).toBe(accent.primary);
    // The wrapper hides it; the glyph itself carries no native-only prop, which
    // react-native-svg's web build would forward to the DOM (#2829).
    expect(glyph.props).not.toHaveProperty('accessible');
  });

  it('draws no check glyph on a quote that has not been folded in', () => {
    const { queryByTestId, UNSAFE_queryByType } = render(
      <QuoteRow text="q" onPress={jest.fn()} accessibilityLabel="q" testID="row" />,
    );

    expect(queryByTestId('row-check', { includeHiddenElements: true })).toBeNull();
    expect(UNSAFE_queryByType(Check)).toBeNull();
  });
});

describe('QuoteRow as a checkbox (#2885)', () => {
  const originalOS = Platform.OS;
  const asPlatform = (os: typeof Platform.OS): void => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
  };
  afterEach(() => asPlatform(originalOS));

  function renderRow(checked: boolean | undefined, disabled = false) {
    return render(
      <QuoteRow
        text="the anger was grief"
        checked={checked}
        onPress={jest.fn()}
        accessibilityLabel="The quote"
        accessibilityState={disabled ? { disabled } : undefined}
        testID="row"
      />,
    );
  }

  it('stays a button when no checked state is given', () => {
    const { getByTestId, queryByTestId } = renderRow(undefined);
    expect(getByTestId('row').props.accessibilityRole).toBe('button');
    expect(queryByTestId('row-box', { includeHiddenElements: true })).toBeNull();
  });

  it.each([true, false])('is a checkbox carrying checked=%s', (checked) => {
    const { getByTestId } = renderRow(checked);
    const row = getByTestId('row');
    expect(row.props.accessibilityRole).toBe('checkbox');
    expect(row.props.accessibilityState).toEqual(expect.objectContaining({ checked }));
  });

  it('draws the box, ticked only when checked, hidden from assistive technology', () => {
    const hidden = { includeHiddenElements: true };
    const ticked = renderRow(true);
    expect(ticked.getByTestId('row-box', hidden)).toBeTruthy();
    expect(ticked.getByTestId('row-box', hidden).props.importantForAccessibility).toBe(
      'no-hide-descendants',
    );
    expect(ticked.getByTestId('row-box', hidden).props['aria-hidden']).toBe(true);
    // Hiding the box loses nothing: the row keeps its checkbox name and state (#3009).
    expect(ticked.getByRole('checkbox', { name: 'The quote', checked: true })).toBeTruthy();
    expect(ticked.UNSAFE_getAllByType(Check)).toHaveLength(1);
    expect(ticked.UNSAFE_getByType(Check).props).not.toHaveProperty('accessible');
    ticked.unmount();
    const empty = renderRow(false);
    expect(empty.getByTestId('row-box', hidden)).toBeTruthy();
    expect(empty.UNSAFE_queryAllByType(Check)).toHaveLength(0);
  });

  // Read off the touchable itself: native TouchableOpacity folds aria-* into
  // accessibilityState before the host view, which would hide the web prop.
  it('writes aria-checked on the web, where accessibilityState is dropped', () => {
    asPlatform('web');
    const touchable = renderRow(true).UNSAFE_getByType(TouchableOpacity);
    expect(touchable.props['aria-checked']).toBe(true);
    expect(touchable.props['aria-disabled']).toBe(false);
  });

  it('writes no aria-* on native, where accessibilityState carries it', () => {
    asPlatform('ios');
    const touchable = renderRow(true).UNSAFE_getByType(TouchableOpacity);
    expect(touchable.props['aria-checked']).toBeUndefined();
    expect(touchable.props['aria-disabled']).toBeUndefined();
  });

  it('writes aria-disabled on the web for a disabled button row, and nothing when none was said', () => {
    asPlatform('web');
    const folded = renderRow(undefined, true);
    expect(folded.UNSAFE_getByType(TouchableOpacity).props['aria-disabled']).toBe(true);
    folded.unmount();
    const plain = renderRow(undefined);
    expect(plain.UNSAFE_getByType(TouchableOpacity).props['aria-disabled']).toBeUndefined();
  });

  it('never puts aria-selected on the row, whichever role it has', () => {
    asPlatform('web');
    for (const checked of [undefined, true, false]) {
      const { UNSAFE_getByType, unmount } = renderRow(checked);
      const touchable = UNSAFE_getByType(TouchableOpacity);
      expect(touchable.props['aria-selected']).toBeUndefined();
      expect(touchable.props.accessibilityState?.selected).toBeUndefined();
      unmount();
    }
  });
});
