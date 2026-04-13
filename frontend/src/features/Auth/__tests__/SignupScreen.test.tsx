/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/context/AuthContext', () => {
  const signup = jest.fn(() => Promise.resolve());
  return {
    useAuth: () => ({ signup, isLoading: false, token: null }),
    _mockSignup: signup,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockSignup: mockSignup } = require('@/context/AuthContext') as any;

import SignupScreen from '../SignupScreen';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('SignupScreen', () => {
  const mockNavigation = { navigate: jest.fn() };

  it('renders email, password, and confirm password fields', () => {
    const { getByPlaceholderText } = render(<SignupScreen navigation={mockNavigation} />);

    expect(getByPlaceholderText('Email')).toBeTruthy();
    expect(getByPlaceholderText('Password')).toBeTruthy();
    expect(getByPlaceholderText('Confirm Password')).toBeTruthy();
  });

  it('shows error when passwords do not match', async () => {
    const { getByPlaceholderText, getByText, findByText } = render(
      <SignupScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.changeText(getByPlaceholderText('Confirm Password'), 'different');
    fireEvent.press(getByText('Sign Up'));

    expect(await findByText(/passwords don't match/i)).toBeTruthy();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('shows error when password is too short', async () => {
    const { getByPlaceholderText, getByText, findByText } = render(
      <SignupScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'short');
    fireEvent.changeText(getByPlaceholderText('Confirm Password'), 'short');
    fireEvent.press(getByText('Sign Up'));

    expect(await findByText(/at least 8 characters/i)).toBeTruthy();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('calls signup with email and password on valid submit', async () => {
    mockSignup.mockResolvedValue(undefined);
    const { getByPlaceholderText, getByText } = render(
      <SignupScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'new@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.changeText(getByPlaceholderText('Confirm Password'), 'password123');
    fireEvent.press(getByText('Sign Up'));

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith('new@test.com', 'password123');
    });
  });

  it('translates backend password_too_short code to user-facing copy', async () => {
    // If the user somehow bypasses the client-side length check (e.g. stale
    // bundle), the backend still enforces it and returns the stable code
    // ``password_too_short``. The screen must not leak snake_case to the UI.
    mockSignup.mockRejectedValue({ detail: 'password_too_short', status: 400 });
    const { getByPlaceholderText, getByText, findByText, queryByText } = render(
      <SignupScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'taken@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.changeText(getByPlaceholderText('Confirm Password'), 'password123');
    fireEvent.press(getByText('Sign Up'));

    expect(await findByText(/at least 8 characters/i)).toBeTruthy();
    expect(queryByText('password_too_short')).toBeNull();
  });

  it('falls back to a connection-hint message when the error is unrecognised', async () => {
    mockSignup.mockRejectedValue(new TypeError('Network request failed'));
    const { getByPlaceholderText, getByText, findByText } = render(
      <SignupScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.changeText(getByPlaceholderText('Confirm Password'), 'password123');
    fireEvent.press(getByText('Sign Up'));

    expect(await findByText(/Check your connection/i)).toBeTruthy();
  });

  it('has a link to navigate to login', () => {
    const { getByText } = render(<SignupScreen navigation={mockNavigation} />);

    fireEvent.press(getByText('Log In'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Login');
  });
});
