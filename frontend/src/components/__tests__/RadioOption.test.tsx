/* eslint-env jest */
/* global describe, it, expect, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { RadioGroup, RadioOption } from '../RadioOption';

const selectedStyle = { backgroundColor: 'rgb(1, 2, 3)' };
const selectedLabelStyle = { color: 'rgb(4, 5, 6)' };
const baseStyle = { borderWidth: 1 };
const baseLabelStyle = { fontSize: 14 };
const groupStyle = { gap: 8 };

describe('RadioOption', () => {
  it('renders the label text and passes through accessibility role/label/testID', () => {
    const { getByText, getByTestId } = render(
      <RadioOption
        label="Morning"
        selected={false}
        onPress={jest.fn()}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    expect(getByText('Morning')).toBeTruthy();
    const node = getByTestId('opt-morning');
    expect(node.props.accessibilityRole).toBe('radio');
    expect(node.props.accessibilityLabel).toBe('Morning');
  });

  it('reflects selected=true in accessibilityState', () => {
    const { getByTestId } = render(
      <RadioOption
        label="Morning"
        selected
        onPress={jest.fn()}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    expect(getByTestId('opt-morning').props.accessibilityState).toEqual({ selected: true });
  });

  it('reflects selected=false in accessibilityState', () => {
    const { getByTestId } = render(
      <RadioOption
        label="Morning"
        selected={false}
        onPress={jest.fn()}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    expect(getByTestId('opt-morning').props.accessibilityState).toEqual({ selected: false });
  });

  it('fires onPress exactly once when pressed', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <RadioOption
        label="Morning"
        selected={false}
        onPress={onPress}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    fireEvent.press(getByTestId('opt-morning'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('passes accessibilityHint through when provided', () => {
    const { getByTestId } = render(
      <RadioOption
        label="Morning"
        selected={false}
        onPress={jest.fn()}
        testID="opt-morning"
        accessibilityHint="Sets your practice window to morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    expect(getByTestId('opt-morning').props.accessibilityHint).toBe(
      'Sets your practice window to morning',
    );
  });

  it('omits accessibilityHint when not provided', () => {
    const { getByTestId } = render(
      <RadioOption
        label="Morning"
        selected={false}
        onPress={jest.fn()}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    expect(getByTestId('opt-morning').props.accessibilityHint).toBeUndefined();
  });

  it('applies the selected container and label styles only when selected', () => {
    const { getByTestId, getByText, rerender } = render(
      <RadioOption
        label="Morning"
        selected={false}
        onPress={jest.fn()}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    const unselectedContainer = StyleSheet.flatten(getByTestId('opt-morning').props.style);
    expect(unselectedContainer.backgroundColor).toBeUndefined();
    const unselectedLabel = StyleSheet.flatten(getByText('Morning').props.style);
    expect(unselectedLabel.color).toBeUndefined();

    rerender(
      <RadioOption
        label="Morning"
        selected
        onPress={jest.fn()}
        testID="opt-morning"
        style={baseStyle}
        selectedStyle={selectedStyle}
        labelStyle={baseLabelStyle}
        selectedLabelStyle={selectedLabelStyle}
      />,
    );
    const selectedContainer = StyleSheet.flatten(getByTestId('opt-morning').props.style);
    expect(selectedContainer.backgroundColor).toBe('rgb(1, 2, 3)');
    const selectedLabel = StyleSheet.flatten(getByText('Morning').props.style);
    expect(selectedLabel.color).toBe('rgb(4, 5, 6)');
  });
});

// A plain View carrying only accessibilityRole is not an accessibility element,
// so getByRole cannot find it; read the flattened host tree via toJSON instead.
function groupNode(element: React.JSX.Element) {
  const tree = render(element).toJSON();
  if (tree === null || Array.isArray(tree)) throw new Error('expected a single group node');
  return tree;
}

describe('RadioGroup', () => {
  it('exposes the radiogroup accessibility role', () => {
    const node = groupNode(
      <RadioGroup style={groupStyle}>
        <View testID="child" />
      </RadioGroup>,
    );
    expect(node.props.accessibilityRole).toBe('radiogroup');
  });

  it('renders its children', () => {
    const { getByTestId } = render(
      <RadioGroup style={groupStyle}>
        <Text testID="child">A child</Text>
      </RadioGroup>,
    );
    expect(getByTestId('child')).toBeTruthy();
  });

  it('passes accessibilityLabel through when provided', () => {
    const node = groupNode(
      <RadioGroup style={groupStyle} accessibilityLabel="Practice time">
        <View testID="child" />
      </RadioGroup>,
    );
    expect(node.props.accessibilityLabel).toBe('Practice time');
  });

  it('omits accessibilityLabel when not provided', () => {
    const node = groupNode(
      <RadioGroup style={groupStyle}>
        <View testID="child" />
      </RadioGroup>,
    );
    expect(node.props.accessibilityLabel).toBeUndefined();
  });

  it('applies the passed style to the group container', () => {
    const node = groupNode(
      <RadioGroup style={groupStyle}>
        <View testID="child" />
      </RadioGroup>,
    );
    const flat = StyleSheet.flatten(node.props.style);
    expect(flat.gap).toBe(8);
  });
});
