/* eslint-env jest */
/* global describe, it, expect, jest, afterEach */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button, busyIndicatorTestID, type ButtonVariant } from '../Button';

import { accent, SPACING, surface, touchTarget } from '@/design/tokens';
import * as reducedMotion from '@/hooks/useReducedMotion';

describe('Button', () => {
  it('renders the label and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId, getByText } = render(<Button label="Save" onPress={onPress} testID="b" />);
    expect(getByText('Save')).toBeTruthy();
    fireEvent.press(getByTestId('b'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPress when disabled or busy', () => {
    const onPress = jest.fn();
    const { getByTestId, rerender } = render(
      <Button label="Save" onPress={onPress} disabled testID="b" />,
    );
    fireEvent.press(getByTestId('b'));
    rerender(<Button label="Save" onPress={onPress} busy testID="b" />);
    fireEvent.press(getByTestId('b'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders each variant with its warm fill/outline', () => {
    const onPress = jest.fn();
    const flat = (variant: 'primary' | 'secondary' | 'tertiary') => {
      const { getByTestId } = render(
        <Button label="X" onPress={onPress} variant={variant} testID={variant} />,
      );
      return StyleSheet.flatten(getByTestId(variant).props.style);
    };
    expect(flat('primary').backgroundColor).toBe(accent.primary);
    expect(flat('secondary').borderColor).toBe(accent.primary);
    expect(flat('secondary').backgroundColor).toBe(surface.raised);
    expect(flat('tertiary').backgroundColor).toBe('transparent');
  });

  it('meets the 44dp minimum touch target', () => {
    const { getByTestId } = render(<Button label="X" onPress={jest.fn()} testID="b" />);
    expect(StyleSheet.flatten(getByTestId('b').props.style).minHeight).toBe(touchTarget.minimum);
  });
});

/**
 * The icon and label-style slots exist for one caller: a button whose look is
 * mandated by someone else (Google's Sign in with Google mark). Both are
 * optional, and every existing caller passes neither — so the guard that
 * matters most is that omitting them changes nothing at all.
 */
describe('Button — optional icon and label-style slots', () => {
  interface RenderedNode {
    props: Record<string, unknown>;
    children: (RenderedNode | string)[] | null;
  }

  /** The button's rendered element children, with any bare text dropped. */
  const childrenOf = (tree: unknown): RenderedNode[] => {
    const children = (tree as RenderedNode | null)?.children ?? [];
    return children.filter((child): child is RenderedNode => typeof child === 'object');
  };

  it('renders no extra node when no icon is given', () => {
    const { toJSON } = render(<Button label="Save" onPress={jest.fn()} testID="b" />);

    const children = childrenOf(toJSON());

    expect(children).toHaveLength(1);
    expect(children[0]?.children).toEqual(['Save']);
  });

  it('renders the icon ahead of the label when one is given', () => {
    const { getByTestId, toJSON } = render(
      <Button
        label="Save"
        onPress={jest.fn()}
        testID="b"
        icon={<Text testID="icon">{'*'}</Text>}
      />,
    );

    const children = childrenOf(toJSON());

    expect(getByTestId('icon')).toBeTruthy();
    expect(children).toHaveLength(2);
    expect(children[0]?.props.testID).toBe('icon');
    expect(children[1]?.children).toEqual(['Save']);
  });

  it('keeps the variant label colour when no labelStyle is given', () => {
    const { getByText } = render(<Button label="Save" onPress={jest.fn()} testID="b" />);

    expect(StyleSheet.flatten(getByText('Save').props.style).color).toBe(accent.onPrimary);
  });

  it('lets labelStyle override the variant label colour', () => {
    const { getByText } = render(
      <Button label="Save" onPress={jest.fn()} testID="b" labelStyle={{ color: '#1F1F1F' }} />,
    );

    expect(StyleSheet.flatten(getByText('Save').props.style).color).toBe('#1F1F1F');
  });

  it('still announces its accessible name with an icon present', () => {
    const { getByLabelText } = render(
      <Button
        label="Save"
        onPress={jest.fn()}
        testID="b"
        accessibilityLabel="Save the draft"
        icon={<Text testID="icon">{'*'}</Text>}
      />,
    );

    expect(getByLabelText('Save the draft')).toBeTruthy();
  });
});

/**
 * ``busy`` and ``disabled`` both stop the press, but only one of them means
 * "your press landed and work is under way". The primitive used to draw them
 * identically — dimmed, static, silent — so a slow request read as a button
 * that had ignored you (#2441). The in-progress mark is the difference.
 */
describe('Button — the busy indicator', () => {
  const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'tertiary'];

  /** The indicator colour each variant's label already uses, per token. */
  const EXPECTED_COLOR: Record<ButtonVariant, string> = {
    primary: accent.onPrimary,
    secondary: accent.primary,
    tertiary: accent.primary,
  };

  const BUSY_ID = busyIndicatorTestID('b');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(VARIANTS)('draws an in-progress mark beside the %s label while busy', (variant) => {
    const { getByTestId, getByText } = render(
      <Button label="Save" onPress={jest.fn()} variant={variant} busy testID="b" />,
    );

    // Assert the button rendered at all, so "no indicator" can never be
    // satisfied by a component that failed to mount.
    expect(getByTestId('b')).toBeTruthy();
    // Beside, not instead of: the label is what tells you *what* is working.
    expect(getByText('Save')).toBeTruthy();
    expect(getByTestId(BUSY_ID).props.color).toBe(EXPECTED_COLOR[variant]);
  });

  it.each(VARIANTS)('draws no mark on the %s variant at rest', (variant) => {
    const { getByTestId, getByText, queryByTestId } = render(
      <Button label="Save" onPress={jest.fn()} variant={variant} testID="b" />,
    );

    expect(getByTestId('b')).toBeTruthy();
    expect(getByText('Save')).toBeTruthy();
    expect(queryByTestId(BUSY_ID)).toBeNull();
  });

  // A mark that appears is only half of it; a mark that never leaves is its own
  // bug, and a test that only ever renders the busy state cannot see that.
  it('takes the mark away again when the work finishes', () => {
    const { queryByTestId, rerender } = render(
      <Button label="Save" onPress={jest.fn()} busy testID="b" />,
    );
    expect(queryByTestId(BUSY_ID)).toBeTruthy();

    rerender(<Button label="Save" onPress={jest.fn()} testID="b" />);

    expect(queryByTestId(BUSY_ID)).toBeNull();
  });

  // A button dimmed because the form is invalid must not claim to be working.
  it('does not claim to be working when it is merely disabled', () => {
    const { getByTestId, queryByTestId } = render(
      <Button label="Save" onPress={jest.fn()} disabled testID="b" />,
    );

    expect(queryByTestId(BUSY_ID)).toBeNull();
    expect(getByTestId('b').props.accessibilityState).toEqual({ disabled: true, busy: false });
  });

  // GoogleSignInButton passes both; the mark has to survive that pairing.
  it('keeps the mark when a caller passes disabled alongside busy', () => {
    const { getByTestId } = render(
      <Button label="Save" onPress={jest.fn()} disabled busy testID="b" />,
    );

    expect(getByTestId(BUSY_ID)).toBeTruthy();
    expect(getByTestId('b').props.accessibilityState).toEqual({ disabled: true, busy: true });
  });

  // Read off the element, not inferred from the mark: a screen reader learns the
  // state from the button, and the mark itself stays mute so the fact is
  // announced once rather than twice.
  it('announces busy through the button while the mark stays mute', () => {
    const { getByTestId } = render(<Button label="Save" onPress={jest.fn()} busy testID="b" />);

    expect(getByTestId('b').props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(getByTestId(BUSY_ID).props.accessible).toBe(false);
  });

  it('spins when motion is welcome', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(false);

    const { getByTestId } = render(<Button label="Save" onPress={jest.fn()} busy testID="b" />);

    expect(getByTestId(BUSY_ID).props.animating).toBe(true);
  });

  // Under reduced motion it settles into a static mark rather than vanishing:
  // ``hidesWhenStopped`` is native behaviour the test renderer cannot observe,
  // so the prop that suppresses it is the thing to assert.
  it('settles into a static mark under reduced motion', () => {
    jest.spyOn(reducedMotion, 'useReducedMotion').mockReturnValue(true);

    const { getByTestId } = render(<Button label="Save" onPress={jest.fn()} busy testID="b" />);

    expect(getByTestId(BUSY_ID).props.animating).toBe(false);
    expect(getByTestId(BUSY_ID).props.hidesWhenStopped).toBe(false);
  });

  // The Google button's colours are Google's, not ours; the mark has to follow
  // the label it sits beside or it goes invisible on their dark theme.
  it('follows a labelStyle colour override so it stays legible on a foreign fill', () => {
    const { getByTestId } = render(
      <Button
        label="Save"
        onPress={jest.fn()}
        variant="tertiary"
        busy
        testID="b"
        labelStyle={{ color: '#1F1F1F' }}
      />,
    );

    expect(getByTestId(BUSY_ID).props.color).toBe('#1F1F1F');
  });

  // Beside the label means beside it: with no gap the mark and the first glyph
  // collide, which is a different bug wearing the same fix.
  it('keeps a token gap between the mark and what follows it', () => {
    const { getByTestId } = render(<Button label="Save" onPress={jest.fn()} busy testID="b" />);

    expect(StyleSheet.flatten(getByTestId(BUSY_ID).props.style).marginRight).toBe(SPACING.sm);
  });

  it('leads the row, ahead of both an icon and the label', () => {
    const { toJSON } = render(
      <Button
        label="Save"
        onPress={jest.fn()}
        busy
        testID="b"
        icon={<Text testID="icon">{'*'}</Text>}
      />,
    );

    const ids = (
      (toJSON() as { children?: ({ props?: { testID?: string } } | string)[] } | null)?.children ??
      []
    )
      .filter((child): child is { props?: { testID?: string } } => typeof child === 'object')
      .map((child) => child.props?.testID);

    expect(ids).toEqual([BUSY_ID, 'icon', undefined]);
  });
});
