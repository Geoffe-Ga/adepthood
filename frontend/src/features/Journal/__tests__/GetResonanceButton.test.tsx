/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import GetResonanceButton, { shouldShowResonance } from '../GetResonanceButton';

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
});
