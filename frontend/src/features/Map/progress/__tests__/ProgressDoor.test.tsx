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
    fireEvent.press(tree.getByRole('button', { name: 'Your progress' }));
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

  it('is hidden when both the habits and practice rings are off', () => {
    rings(false, false);
    expect(render(<ProgressDoor />).queryByTestId('map-progress-door')).toBeNull();
  });
});
