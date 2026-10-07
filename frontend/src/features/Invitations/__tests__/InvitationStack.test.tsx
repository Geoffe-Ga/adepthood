/* eslint-env jest */
import { jest, afterEach, beforeEach, describe, it, expect } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockDismiss = jest.fn();
let mockInvitations: Invitation[] = [];
jest.mock('../useInvitations', () => ({
  useInvitations: () => ({ invitations: mockInvitations, dismiss: mockDismiss }),
}));

import InvitationStack from '../InvitationStack';

import type { Invitation } from '@/api';
import { useDepthPreferencesStore } from '@/store/useDepthPreferencesStore';

type DepthFlag = 'enable_habits' | 'enable_practices' | 'enable_course' | 'enable_sangha';

const makeInvitation = (
  id: number,
  target_type: Invitation['target_type'] = 'practice',
): Invitation => ({
  id,
  target_type,
  target_id: null,
  kind: 'readiness',
  created_at: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  mockDismiss.mockClear();
  mockInvitations = [];
});

describe('InvitationStack', () => {
  it('renders nothing when there are no pending invitations', () => {
    const { toJSON } = render(<InvitationStack />);
    expect(toJSON()).toBeNull();
  });

  it('renders one card per pending invitation', () => {
    mockInvitations = [makeInvitation(1), makeInvitation(2)];
    const { getByTestId } = render(<InvitationStack />);
    expect(getByTestId('invitation-1')).toBeTruthy();
    expect(getByTestId('invitation-2')).toBeTruthy();
  });

  it('dismisses the invitation by id when its decline button is pressed', () => {
    mockInvitations = [makeInvitation(5)];
    const { getByTestId } = render(<InvitationStack />);
    fireEvent.press(getByTestId('invitation-5-dismiss'));
    expect(mockDismiss).toHaveBeenCalledWith(5);
  });
});

describe('InvitationStack — declined depths (#3073)', () => {
  afterEach(() => {
    useDepthPreferencesStore.getState().reset();
  });

  it('drops a card the moment its ring is declined, with no remount', () => {
    mockInvitations = [makeInvitation(1, 'course'), makeInvitation(2, 'practice')];
    const { queryByTestId, getByTestId } = render(<InvitationStack />);
    expect(getByTestId('invitation-1')).toBeTruthy();

    act(() => {
      useDepthPreferencesStore.setState({ enable_course: false });
    });

    expect(queryByTestId('invitation-1')).toBeNull();
    expect(getByTestId('invitation-2')).toBeTruthy();
  });

  const cases: [Invitation['target_type'], DepthFlag][] = [
    ['habit', 'enable_habits'],
    ['practice', 'enable_practices'],
    ['course', 'enable_course'],
    ['sangha', 'enable_sangha'],
    ['embodied_community', 'enable_sangha'],
  ];

  it.each(cases)('hides a %s invitation while %s is off', (targetType, flag) => {
    useDepthPreferencesStore.setState({ [flag]: false });
    mockInvitations = [makeInvitation(7, targetType)];
    const { toJSON } = render(<InvitationStack />);
    expect(toJSON()).toBeNull();
  });
});
