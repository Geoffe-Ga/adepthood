/* eslint-env jest */
/* global describe, it, expect, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button } from '../Button';

import { accent, surface, touchTarget } from '@/design/tokens';

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
