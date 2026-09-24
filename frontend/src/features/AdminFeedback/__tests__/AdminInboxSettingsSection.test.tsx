import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const mockNavigate = jest.fn();
const mockCapabilities = jest.fn<() => Promise<{ feedback_triage: boolean }>>();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));
jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ token: 'hub-token', logout: jest.fn() }),
}));
jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return { ...actual, adminFeedback: { capabilities: () => mockCapabilities() } };
});

import { AdminInboxSettingsSection } from '../AdminInboxSettingsSection';

import { ApiError } from '@/api';

const HTTP_FORBIDDEN = 403;
const ROW = 'settings-row-feedback-inbox';

beforeEach(() => {
  mockCapabilities.mockReset();
  mockNavigate.mockReset();
});

describe('the Settings entry to the feedback inbox', () => {
  it('is absent while the server has not answered', () => {
    mockCapabilities.mockReturnValue(new Promise(() => undefined));
    const screen = render(<AdminInboxSettingsSection />);
    expect(screen.queryByTestId(ROW)).toBeNull();
  });

  it('stays absent for a non-operator', async () => {
    mockCapabilities.mockRejectedValue(new ApiError(HTTP_FORBIDDEN, 'admin_required'));
    const screen = render(<AdminInboxSettingsSection />);
    await waitFor(() => expect(mockCapabilities).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId(ROW)).toBeNull());
  });

  it('appears for a confirmed operator and opens the inbox', async () => {
    mockCapabilities.mockResolvedValue({ feedback_triage: true });
    const screen = render(<AdminInboxSettingsSection />);
    await waitFor(() => expect(screen.getByTestId(ROW)).toBeTruthy());
    fireEvent.press(screen.getByTestId(ROW));
    expect(mockNavigate).toHaveBeenCalledWith('AdminFeedback');
  });
});
