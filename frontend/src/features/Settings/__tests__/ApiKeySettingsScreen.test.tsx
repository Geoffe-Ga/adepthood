/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert } from 'react-native';

import ApiKeySettingsScreen, { validateUserApiKey } from '../ApiKeySettingsScreen';

import { useApiKey } from '@/context/ApiKeyContext';

jest.mock('@/context/ApiKeyContext', () => ({
  useApiKey: jest.fn(),
}));

const mockUseApiKey = useApiKey as jest.MockedFunction<typeof useApiKey>;

const VALID_KEY = 'sk-user-owned-example-key-0123456789';

function setApiKeyState(partial: Partial<ReturnType<typeof useApiKey>>) {
  const base = {
    apiKey: null,
    isLoading: false,
    saveApiKey: jest.fn(() => Promise.resolve()),
    clearApiKey: jest.fn(() => Promise.resolve()),
  };
  const value = { ...base, ...partial } as ReturnType<typeof useApiKey>;
  mockUseApiKey.mockReturnValue(value);
  return value;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('validateUserApiKey', () => {
  test('accepts a well-formed OpenAI key', () => {
    expect(validateUserApiKey(VALID_KEY)).toBeNull();
  });

  test('accepts a well-formed Anthropic key', () => {
    expect(validateUserApiKey(`sk-ant-${'x'.repeat(60)}`)).toBeNull();
  });

  test('rejects an empty or whitespace-only input', () => {
    expect(validateUserApiKey('')?.code).toBe('empty');
    expect(validateUserApiKey('   ')?.code).toBe('empty');
  });

  test('rejects a key without the expected prefix', () => {
    expect(validateUserApiKey('definitely-not-real-enough')?.code).toBe('bad_prefix');
  });

  test('rejects a key that is too short', () => {
    expect(validateUserApiKey('sk-a')?.code).toBe('too_short');
  });

  test('rejects a key that is too long', () => {
    expect(validateUserApiKey(`sk-${'x'.repeat(300)}`)?.code).toBe('too_long');
  });
});

describe('ApiKeySettingsScreen', () => {
  test('shows the loading indicator while the stored key is being read', () => {
    setApiKeyState({ isLoading: true });
    const { getByTestId, queryByTestId } = render(<ApiKeySettingsScreen />);
    expect(getByTestId('api-key-loading')).toBeTruthy();
    expect(queryByTestId('save-key-button')).toBeNull();
  });

  test('shows a hint when no key is saved yet', () => {
    setApiKeyState({});
    const { getByTestId } = render(<ApiKeySettingsScreen />);
    expect(getByTestId('no-key-hint')).toBeTruthy();
  });

  test('shows a masked summary of the stored key', () => {
    setApiKeyState({ apiKey: VALID_KEY });
    const { getByText, queryByText } = render(<ApiKeySettingsScreen />);
    // The raw key must not appear — only a mask with the first and last
    // few characters plus bullet fill.
    expect(queryByText(VALID_KEY)).toBeNull();
    expect(getByText(/^sk-u/)).toBeTruthy();
    expect(getByText(/••••/)).toBeTruthy();
  });

  test('rejects a malformed key and does not persist it', async () => {
    const state = setApiKeyState({});
    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), 'not-a-real-key');
    fireEvent.press(getByTestId('save-key-button'));

    const error = await findByTestId('api-key-error');
    expect(error).toBeTruthy();
    expect(state.saveApiKey).not.toHaveBeenCalled();
  });

  test('persists a well-formed key and clears the input', async () => {
    const state = setApiKeyState({});
    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });

    await waitFor(() => expect(state.saveApiKey).toHaveBeenCalledWith(VALID_KEY));
    const status = await findByTestId('api-key-status');
    expect(status).toBeTruthy();
    // Input should have been cleared after save.
    expect(getByTestId('api-key-input').props.value).toBe('');
  });

  test('the reveal toggle flips secureTextEntry', () => {
    setApiKeyState({});
    const { getByTestId } = render(<ApiKeySettingsScreen />);
    const input = getByTestId('api-key-input');
    expect(input.props.secureTextEntry).toBe(true);
    fireEvent.press(getByTestId('reveal-toggle'));
    expect(input.props.secureTextEntry).toBe(false);
  });

  test('remove button asks for confirmation before clearing', async () => {
    const state = setApiKeyState({ apiKey: VALID_KEY });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      // Simulate the user tapping the destructive "Remove" button.
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const { getByTestId } = render(<ApiKeySettingsScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    await waitFor(() => expect(state.clearApiKey).toHaveBeenCalled());
    alertSpy.mockRestore();
  });
});
