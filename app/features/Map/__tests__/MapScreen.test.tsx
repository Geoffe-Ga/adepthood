/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
/* eslint-disable import/order */
import React from 'react';
import { act, create } from 'react-test-renderer';

import MapScreen from '../MapScreen';

// Mock navigation so we can observe tab linking behaviour.
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

describe('MapScreen', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  it('renders ten stage hotspots', () => {
    const tree = create(<MapScreen />);
    const stages = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-hotspot'),
    );
    const unique = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stages.map((s: any) => s.props.testID as string),
    );
    expect(unique.size).toBe(10);
  });

  it('shows modal with stage details when a hotspot is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1' }).props.onPress();
    });
    const modal = tree.root.findByProps({ testID: 'stage-modal' });
    expect(modal).toBeTruthy();
  });

  it('navigates to Practice when Practice is tapped inside modal', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'stage-hotspot-1' }).props.onPress();
    });
    act(() => {
      tree.root.findByProps({ testID: 'practice-link' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Practice');
  });
});
