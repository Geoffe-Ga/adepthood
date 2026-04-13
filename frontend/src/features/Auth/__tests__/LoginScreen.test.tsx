/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/context/AuthContext', () => {
  const login = jest.fn(() => Promise.resolve());
  return {
    useAuth: () => ({ login, isLoading: false, token: null }),
    _mockLogin: login,
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockLogin: mockLogin } = require('@/context/AuthContext') as any;

import LoginScreen from '../LoginScreen';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LoginScreen', () => {
  const mockNavigation = { navigate: jest.fn() };

  it('renders email and password fields', () => {
    const { getByPlaceholderText } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByPlaceholderText('Email')).toBeTruthy();
    expect(getByPlaceholderText('Password')).toBeTruthy();
  });

  it('renders a login button', () => {
    const { getByText } = render(<LoginScreen navigation={mockNavigation} />);

    expect(getByText('Log In')).toBeTruthy();
  });

  it('calls login with email and password on submit', async () => {
    mockLogin.mockResolvedValue(undefined);
    const { getByPlaceholderText, getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'password123');
    fireEvent.press(getByText('Log In'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith('user@test.com', 'password123');
    });
  });

  it('translates the backend invalid_credentials code to user-facing copy', async () => {
    // The backend returns the stable code ``invalid_credentials`` (see
    // backend/src/routers/auth.py). The screen must not leak snake_case to
    // the user — it should display the mapped friendly message instead.
    mockLogin.mockRejectedValue({ detail: 'invalid_credentials', status: 401 });
    const { getByPlaceholderText, getByText, findByText, queryByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'wrong');
    fireEvent.press(getByText('Log In'));

    expect(await findByText(/email and password/i)).toBeTruthy();
    expect(queryByText('invalid_credentials')).toBeNull();
  });

  it('falls back to a connection-hint message when the error is unrecognised', async () => {
    mockLogin.mockRejectedValue(new TypeError('Network request failed'));
    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen navigation={mockNavigation} />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), 'user@test.com');
    fireEvent.changeText(getByPlaceholderText('Password'), 'whatever');
    fireEvent.press(getByText('Log In'));

    expect(await findByText(/Check your connection/i)).toBeTruthy();
  });

  it('has a link to navigate to signup', () => {
    const { getByText } = render(<LoginScreen navigation={mockNavigation} />);

    fireEvent.press(getByText('Sign Up'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Signup');
  });
});
