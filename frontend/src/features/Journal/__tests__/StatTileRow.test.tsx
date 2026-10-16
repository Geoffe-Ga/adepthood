/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

jest.mock('../HabitsStatTile', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="stub-habits" />;
  return { __esModule: true, default: Stub };
});

jest.mock('../PracticesStatTile', () => {
  const { View } = require('react-native');
  const Stub = () => <View testID="stub-practices" />;
  return { __esModule: true, default: Stub };
});

import s, { STAT_TILE_MIN_COLUMN } from '../StatTile.styles';
import StatTileRow from '../StatTileRow';

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

beforeEach(() => {
  useDepthPreferencesStore.setState({ enable_habits: true, enable_practices: true });
});

describe('StatTileRow', () => {
  it('renders the row with both tiles when both rings are on', () => {
    const { getByTestId } = render(<StatTileRow />);
    expect(getByTestId('journal-stat-tile-row')).toBeTruthy();
    expect(getByTestId('stub-habits')).toBeTruthy();
    expect(getByTestId('stub-practices')).toBeTruthy();
  });

  it('hides the habits tile when the habits ring is off', () => {
    useDepthPreferencesStore.setState({ enable_habits: false, enable_practices: true });
    const { getByTestId, queryByTestId } = render(<StatTileRow />);
    expect(getByTestId('journal-stat-tile-row')).toBeTruthy();
    expect(queryByTestId('stub-habits')).toBeNull();
    expect(getByTestId('stub-practices')).toBeTruthy();
  });

  it('hides the practices tile when the practices ring is off', () => {
    useDepthPreferencesStore.setState({ enable_habits: true, enable_practices: false });
    const { getByTestId, queryByTestId } = render(<StatTileRow />);
    expect(getByTestId('journal-stat-tile-row')).toBeTruthy();
    expect(getByTestId('stub-habits')).toBeTruthy();
    expect(queryByTestId('stub-practices')).toBeNull();
  });

  it('renders nothing when both rings are off', () => {
    useDepthPreferencesStore.setState({ enable_habits: false, enable_practices: false });
    const { queryByTestId } = render(<StatTileRow />);
    expect(queryByTestId('journal-stat-tile-row')).toBeNull();
  });

  it('wraps its tiles into a column when two cannot each keep a whole-word column (#3440)', () => {
    const { getByTestId } = render(<StatTileRow />);
    const row = StyleSheet.flatten(getByTestId('journal-stat-tile-row').props.style);
    expect(row.flexWrap).toBe('wrap');
    const tile = StyleSheet.flatten(s.tile);
    expect(tile.flexBasis).toBe(STAT_TILE_MIN_COLUMN);
    // Equal growth keeps two side-by-side tiles the same width, as before.
    expect(tile.flexGrow).toBe(1);
    expect(Object.keys(tile)).not.toContain('flex');
  });
});
