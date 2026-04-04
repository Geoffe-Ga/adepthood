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

    expect(await findByText('Passwords do not match')).toBeTruthy();
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

    expect(await findByText('Password must be at least 8 characters')).toBeTruthy();
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

  it('shows error message on signup failure', async () => {
    mockSignup.mockRejectedValue({ detail: 'Email already exists' });
    const { getByPlaceholderText, getByText, findByText } = render(
      <SignupScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'taken@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.changeText(getByPlaceholderText('Confirm Password'), 'password123');
    fireEvent.press(getByText('Sign Up'));

    expect(await findByText('Email already exists')).toBeTruthy();
  });

  it('has a link to navigate to login', () => {
    const { getByText } = render(<SignupScreen navigation={mockNavigation} />);

    fireEvent.press(getByText('Log In'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Login');
  });
});
