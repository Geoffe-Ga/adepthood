import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import { ProgressDoor } from '../ProgressDoor';

import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as object),
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const rings = (enable_habits: boolean, enable_practices: boolean) =>
  useDepthPreferencesStore.setState({ enable_habits, enable_practices });

beforeEach(() => {
  mockNavigate.mockClear();
  rings(true, true);
});

describe('ProgressDoor', () => {
  it('opens the Progress screen and closes the drawer', () => {
    const onOpen = jest.fn();
    const tree = render(<ProgressDoor onOpen={onOpen} />);
    fireEvent.press(tree.getByRole('button', { name: 'Stats and progress' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Progress');
  });

  it.each([
    [true, false],
    [false, true],
  ])('stays when habits=%s and practices=%s', (habits, practices) => {
    rings(habits, practices);
    expect(render(<ProgressDoor />).getByTestId('map-progress-door')).toBeTruthy();
  });

  it('draws a divider after the door, setting it apart from the stage legend', () => {
    const tree = render(<ProgressDoor />);
    tree.getByTestId('map-progress-door-divider');
    // The divider follows the door, not precedes it.
    const json = JSON.stringify(tree.toJSON());
    expect(json.indexOf('map-progress-door-divider')).toBeGreaterThan(
      json.indexOf('"map-progress-door"'),
    );
  });

  it('is hidden, divider and all, when both the habits and practice rings are off', () => {
    rings(false, false);
    const tree = render(<ProgressDoor />);
    expect(tree.queryByTestId('map-progress-door')).toBeNull();
    expect(tree.queryByTestId('map-progress-door-divider')).toBeNull();
  });
});
