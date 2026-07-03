/* eslint-env jest */
import { jest, beforeEach, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

const mockDismiss = jest.fn();
let mockInvitations: Invitation[] = [];
jest.mock('../useInvitations', () => ({
  useInvitations: () => ({ invitations: mockInvitations, dismiss: mockDismiss }),
}));

import InvitationStack from '../InvitationStack';

import type { Invitation } from '@/api';

const makeInvitation = (id: number): Invitation => ({
  id,
  target_type: 'practice',
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
