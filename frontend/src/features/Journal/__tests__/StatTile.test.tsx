/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import StatTile from '../StatTile';

const baseProps = {
  title: 'Today',
  cue: 'Open →',
  accessibilityLabel: 'Today. Open',
  testID: 'stat-tile',
};

describe('StatTile', () => {
  it('renders the stat line when a stat is provided and not loading', () => {
    const { getByText, queryByTestId } = render(
      <StatTile {...baseProps} stat="1/3 done" onPress={jest.fn()} />,
    );
    expect(getByText('1/3 done')).toBeTruthy();
    expect(queryByTestId('stat-tile-skeleton')).toBeNull();
  });

  it('renders the skeleton and no stat while loading', () => {
    const { getByTestId, queryByText } = render(
      <StatTile {...baseProps} loading stat="1/3 done" onPress={jest.fn()} />,
    );
    expect(getByTestId('stat-tile-skeleton')).toBeTruthy();
    expect(queryByText('1/3 done')).toBeNull();
  });

  it('renders no stat body when neither loading nor a stat is given', () => {
    const { queryByTestId, getByText } = render(<StatTile {...baseProps} onPress={jest.fn()} />);
    expect(queryByTestId('stat-tile-skeleton')).toBeNull();
    expect(getByText('Today')).toBeTruthy();
    expect(getByText('Open →')).toBeTruthy();
  });

  it('is a button that fires onPress when tapped', () => {
    const onPress = jest.fn();
    const { getByTestId } = render(<StatTile {...baseProps} onPress={onPress} />);
    const tile = getByTestId('stat-tile');
    expect(tile.props.accessibilityRole).toBe('button');
    fireEvent.press(tile);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
