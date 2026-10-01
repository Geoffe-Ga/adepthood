import { describe, it, expect, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';

/**
 * Specs for ``ReflectionDismiss`` — the shared press target for the raised
 * reflection cards. The ``dismiss`` and ``reopen`` treatments are pinned here so
 * the ``close`` (icon-only X) variant added for the care note (#2862) cannot leak
 * its absolute placement or the optional ``textStyle`` into the text variants
 * every other card relies on.
 */
import ReflectionDismiss, {
  CLOSE_ACTIVE_OPACITY,
  CLOSE_ICON_SIZE,
  CLOSE_PRESSED_COLOR,
  CLOSE_REST_COLOR,
  closeCornerReserve,
} from '../ReflectionDismiss';

import { decorativeHidden } from '@/components/a11yHidden';
import { SPACING, accent, editorialType, ink, touchTarget } from '@/design/tokens';

const noop = (): void => undefined;

function controlStyle(node: { props: { style: unknown } }): ViewStyle {
  return (StyleSheet.flatten(node.props.style as ViewStyle) ?? {}) as ViewStyle;
}

function textStyle(node: { props: { style: unknown } }): TextStyle {
  return (StyleSheet.flatten(node.props.style as TextStyle) ?? {}) as TextStyle;
}

describe('ReflectionDismiss — dismiss variant (unchanged)', () => {
  it('keeps the muted text control below the body with a 44dp target', () => {
    const { getByTestId, getByText } = render(
      <ReflectionDismiss label="Dismiss" accessibilityLabel="Hide it" testID="d" onPress={noop} />,
    );
    const control = controlStyle(getByTestId('d'));
    expect(control.marginTop).toBe(SPACING.md);
    expect(control.minHeight).toBe(touchTarget.minimum);
    expect(control.minWidth).toBe(touchTarget.minimum);
    expect(control.position).toBeUndefined();
    const label = textStyle(getByText('Dismiss'));
    expect(label.color).toBe(ink.soft);
    expect(label.fontSize).toBe(editorialType.note.fontSize);
  });
});

describe('ReflectionDismiss — reopen variant (unchanged)', () => {
  it('sits flush in the accent tone with a 44dp target', () => {
    const { getByTestId, getByText } = render(
      <ReflectionDismiss
        variant="reopen"
        label="Show"
        accessibilityLabel="Show it"
        testID="r"
        onPress={noop}
      />,
    );
    const control = controlStyle(getByTestId('r'));
    expect(control.marginTop).toBe(0);
    expect(control.minHeight).toBe(touchTarget.minimum);
    expect(control.position).toBeUndefined();
    expect(textStyle(getByText('Show')).color).toBe(accent.primary);
  });

  it('appends an optional textStyle after the variant face', () => {
    const { getByText } = render(
      <ReflectionDismiss
        variant="reopen"
        label="Show"
        accessibilityLabel="Show it"
        testID="r"
        onPress={noop}
        textStyle={{ fontSize: editorialType.action.fontSize }}
      />,
    );
    const label = textStyle(getByText('Show'));
    expect(label.fontSize).toBe(editorialType.action.fontSize);
    expect(label.color).toBe(accent.primary);
  });
});

describe('ReflectionDismiss — close variant (icon-only X, #2862)', () => {
  function renderClose(onPress: () => void = noop) {
    return render(
      <ReflectionDismiss
        variant="close"
        accessibilityLabel="Hide the note"
        testID="x"
        onPress={onPress}
      />,
    );
  }

  it('is a labelled button with no visible text', () => {
    const { getByTestId, queryAllByText } = renderClose();
    const control = getByTestId('x');
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('Hide the note');
    expect(queryAllByText(/.+/)).toHaveLength(0);
  });

  it('draws the lucide X glyph at 20dp in the soft ink, hidden from the a11y tree', () => {
    const icons = renderClose().UNSAFE_getAllByType(X);
    expect(icons).toHaveLength(1);
    const [icon] = icons;
    expect(CLOSE_ICON_SIZE).toBe(20);
    expect(icon?.props.size).toBe(CLOSE_ICON_SIZE);
    expect(icon?.props.color).toBe(ink.soft);
    // The one spelling that hides it on native and on the web alike (#2829).
    expect(icon?.props).toMatchObject(decorativeHidden());
  });

  it('sits absolutely in the top-right corner', () => {
    const control = controlStyle(renderClose().getByTestId('x'));
    expect(control.position).toBe('absolute');
    expect(control.top).toBe(0);
    expect(control.right).toBe(0);
    expect(control.marginTop).toBe(0);
  });

  it('keeps a 44dp hit area', () => {
    const control = controlStyle(renderClose().getByTestId('x'));
    expect(control.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(control.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('calls onPress when tapped', () => {
    const onPress = jest.fn();
    fireEvent.press(renderClose(onPress).getByTestId('x'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('tints the X accent while pressed and returns to soft ink on release (#2860)', () => {
    const view = renderClose();
    const iconColor = (): unknown => view.UNSAFE_getByType(X).props.color;
    expect(CLOSE_REST_COLOR).toBe(ink.soft);
    expect(CLOSE_PRESSED_COLOR).toBe(accent.primary);
    expect(iconColor()).toBe(ink.soft);
    fireEvent(view.getByTestId('x'), 'pressIn');
    expect(iconColor()).toBe(accent.primary);
    fireEvent(view.getByTestId('x'), 'pressOut');
    expect(iconColor()).toBe(ink.soft);
  });

  it('keeps the X fully opaque while held, so the accent is not faded to a wash', () => {
    // RNTL's fireEvent skips Pressability's opacity path, so this pins the prop;
    // the browser spec measures the held control's computed opacity.
    expect(CLOSE_ACTIVE_OPACITY).toBe(1);
    expect(renderClose().UNSAFE_getByType(TouchableOpacity).props.activeOpacity).toBe(1);
  });

  it('does not treat a press-in alone as the press', () => {
    const onPress = jest.fn();
    fireEvent(renderClose(onPress).getByTestId('x'), 'pressIn');
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('closeCornerReserve — the room a card keeps clear of its corner X', () => {
  it('is the part of the 44dp hit area that reaches past the card padding', () => {
    expect(closeCornerReserve(SPACING.lg)).toBe(touchTarget.minimum - SPACING.lg);
  });

  it('is the whole hit area on an unpadded card', () => {
    expect(closeCornerReserve(0)).toBe(touchTarget.minimum);
  });

  it('never goes negative when the padding already clears the hit area', () => {
    expect(closeCornerReserve(touchTarget.minimum + SPACING.lg)).toBe(0);
  });
});
