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

  it('renders ten unique stage cards', () => {
    const tree = create(<MapScreen />);
    const stages = tree.root.findAll(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (node: any) =>
        typeof node.props.testID === 'string' && node.props.testID.startsWith('stage-card'),
    );
    const uniqueIds = new Set(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stages.map((s: any) => s.props.testID as string),
    );
    expect(uniqueIds.size).toBe(10);
  });

  it('navigates to Practice when Practice is tapped', () => {
    const tree = create(<MapScreen />);
    act(() => {
      tree.root.findByProps({ testID: 'practice-button-1' }).props.onPress();
    });
    expect(mockNavigate).toHaveBeenCalledWith('Practice');
  });
});
