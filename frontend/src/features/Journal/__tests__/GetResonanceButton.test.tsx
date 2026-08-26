/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

import GetResonanceButton, { shouldShowResonance } from '../GetResonanceButton';

/** Flatten the button's outermost wrapper style (the layout variant lives there). */
function wrapperStyle(style: StyleProp<ViewStyle>): ViewStyle {
  return StyleSheet.flatten(style);
}

describe('shouldShowResonance', () => {
  it('shows only when idle with content', () => {
    expect(shouldShowResonance({ isIdle: true, hasContent: true, isLoading: false })).toBe(true);
    expect(shouldShowResonance({ isIdle: false, hasContent: true, isLoading: false })).toBe(false);
    expect(shouldShowResonance({ isIdle: true, hasContent: false, isLoading: false })).toBe(false);
  });

  it('stays visible while a pass is loading regardless of idle/content', () => {
    expect(shouldShowResonance({ isIdle: false, hasContent: false, isLoading: true })).toBe(true);
  });
});

describe('GetResonanceButton', () => {
  it('fires onPress when visible and idle', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<GetResonanceButton visible onPress={onPress} />);
    fireEvent.press(getByTestId('get-resonance-button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows a busy label and is disabled while loading', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(
      <GetResonanceButton visible loading onPress={onPress} />,
    );
    expect(getByText('Listening…')).toBeTruthy();
    fireEvent.press(getByTestId('get-resonance-button'));
    expect(onPress).not.toHaveBeenCalled();
    expect(getByTestId('get-resonance-button').props.accessibilityState.busy).toBe(true);
  });

  it('does not fire onPress when disabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<GetResonanceButton visible disabled onPress={onPress} />);
    fireEvent.press(getByTestId('get-resonance-button'));
    expect(onPress).not.toHaveBeenCalled();
    expect(getByTestId('get-resonance-button').props.accessibilityState.disabled).toBe(true);
  });

  it('is inert (hidden from a11y, not pressable) when not visible', () => {
    const onPress = jest.fn();
    const { queryByTestId } = render(<GetResonanceButton visible={false} onPress={onPress} />);
    // Hidden from the accessibility tree, so default queries don't surface it
    // (accessibilityElementsHidden + no-hide-descendants) — i.e. not focusable.
    expect(queryByTestId('get-resonance-button')).toBeNull();
    // And with includeHiddenElements, the press handler is detached.
    const button = queryByTestId('get-resonance-button', { includeHiddenElements: true });
    expect(button).not.toBeNull();
    fireEvent.press(button!);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders a live progress indicator beside the busy label while a pass runs', () => {
    const { getByTestId, getByText } = render(
      <GetResonanceButton visible loading onPress={jest.fn()} />,
    );
    expect(getByTestId('resonance-loading')).toBeTruthy();
    expect(getByText('Listening…')).toBeTruthy();
  });

  it('shows no progress indicator when no pass is running', () => {
    const { queryByTestId } = render(<GetResonanceButton visible onPress={jest.fn()} />);
    expect(queryByTestId('resonance-loading')).toBeNull();
  });

  it('floats above the page by default', () => {
    const view = render(<GetResonanceButton visible onPress={jest.fn()} />);
    expect(wrapperStyle(view.root.props.style).position).toBe('absolute');
  });

  it('sits in the page flow when laid out inline', () => {
    const view = render(<GetResonanceButton visible layout="inline" onPress={jest.fn()} />);
    expect(wrapperStyle(view.root.props.style).position).not.toBe('absolute');
  });

  it('keeps the inline variant inert and busy while a pass runs', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <GetResonanceButton visible loading layout="inline" onPress={onPress} />,
    );
    fireEvent.press(getByTestId('get-resonance-button'));
    expect(onPress).not.toHaveBeenCalled();
    expect(getByTestId('get-resonance-button').props.accessibilityState.busy).toBe(true);
  });

  it('costs no layout space when hidden inline', () => {
    const view = render(<GetResonanceButton visible={false} layout="inline" onPress={jest.fn()} />);
    const style = wrapperStyle(view.root.props.style);
    expect(style.height).toBe(0);
    expect(style.overflow).toBe('hidden');
  });

  it('keeps its own height when shown inline', () => {
    const view = render(<GetResonanceButton visible layout="inline" onPress={jest.fn()} />);
    const style = wrapperStyle(view.root.props.style);
    expect(style.height).not.toBe(0);
    expect(style.overflow).not.toBe('hidden');
  });

  it('leaves the floating variant uncollapsed when hidden, since it takes no flow space', () => {
    const view = render(<GetResonanceButton visible={false} onPress={jest.fn()} />);
    const style = wrapperStyle(view.root.props.style);
    expect(style.position).toBe('absolute');
    expect(style.height).not.toBe(0);
    expect(style.overflow).not.toBe('hidden');
  });
});
