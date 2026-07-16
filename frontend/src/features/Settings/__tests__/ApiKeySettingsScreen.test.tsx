/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Alert, Linking } from 'react-native';

import ApiKeySettingsScreen, {
  SECURE_STORAGE_WARNING,
  validateUserApiKey,
} from '../ApiKeySettingsScreen';
import { BYOK_PROVIDERS, providerForKey } from '../byokProviders';

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
    loadError: null,
    saveApiKey: jest.fn(() => Promise.resolve({ persisted: true })),
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

describe('byokProviders', () => {
  test('detects each supported provider from its key prefix', () => {
    expect(providerForKey(VALID_KEY)?.id).toBe('openai');
    expect(providerForKey(`sk-ant-${'x'.repeat(60)}`)?.id).toBe('anthropic');
  });

  test('returns null for an unrecognized key', () => {
    expect(providerForKey('definitely-not-real-enough')).toBeNull();
  });

  test('every provider carries a key-page url and a hint', () => {
    expect(BYOK_PROVIDERS.length).toBeGreaterThanOrEqual(2);
    for (const provider of BYOK_PROVIDERS) {
      expect(provider.keyPageUrl).toMatch(/^https:\/\//);
      expect(provider.hint).toContain(provider.keyPrefix);
    }
  });
});

describe('provider deep links and detection', () => {
  test('renders a "Get your API key" link per provider opening its key page', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    setApiKeyState({});
    const { getByTestId } = render(<ApiKeySettingsScreen />);
    for (const provider of BYOK_PROVIDERS) {
      fireEvent.press(getByTestId(`get-key-link-${provider.id}`));
      expect(openURL).toHaveBeenLastCalledWith(provider.keyPageUrl);
    }
    expect(openURL).toHaveBeenCalledTimes(BYOK_PROVIDERS.length);
  });

  test('shows the detected provider while typing a recognizable key', () => {
    setApiKeyState({});
    const { getByTestId, queryByTestId } = render(<ApiKeySettingsScreen />);
    fireEvent.changeText(getByTestId('api-key-input'), `sk-ant-${'x'.repeat(60)}`);
    expect(getByTestId('detected-provider').props.children.join('')).toContain('Anthropic');
    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    expect(getByTestId('detected-provider').props.children.join('')).toContain('OpenAI');
    fireEvent.changeText(getByTestId('api-key-input'), 'garbage');
    expect(queryByTestId('detected-provider')).toBeNull();
  });
});

describe('ApiKeySettingsScreen', () => {
  test('renders on the warm screen scaffold', () => {
    setApiKeyState({});
    const { getByTestId } = render(<ApiKeySettingsScreen />);
    expect(getByTestId('api-key-settings-screen')).toBeTruthy();
  });

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

  test('navigates to the Time zone settings from the footer entry', () => {
    setApiKeyState({});
    const navigate = jest.fn();
    const { getByTestId } = render(<ApiKeySettingsScreen navigation={{ navigate }} />);

    fireEvent.press(getByTestId('open-timezone-settings'));

    expect(navigate).toHaveBeenCalledWith('TimezoneSettings');
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

  test('clears the success banner once the draft changes after a save', async () => {
    setApiKeyState({});
    const { getByTestId, findByTestId, queryByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });
    await findByTestId('api-key-status');

    // Typing a replacement key must retire the stale "saved" confirmation.
    fireEvent.changeText(getByTestId('api-key-input'), 'typing a new value');

    expect(queryByTestId('api-key-status')).toBeNull();
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

  test('dismissing the remove confirmation does not clear the key', async () => {
    const state = setApiKeyState({ apiKey: VALID_KEY });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      // Simulate the user tapping "Cancel" instead of the destructive action.
      const cancel = buttons?.find((b) => b.style === 'cancel');
      cancel?.onPress?.();
    });

    const { getByTestId } = render(<ApiKeySettingsScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    expect(state.clearApiKey).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  test('shows an error banner when saving a well-formed key fails', async () => {
    const state = setApiKeyState({
      saveApiKey: jest.fn(() => Promise.reject(new Error('network unreachable'))),
    });
    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });

    const error = await findByTestId('api-key-error');
    expect(error.props.children).toContain('network unreachable');
    expect(state.saveApiKey).toHaveBeenCalledWith(VALID_KEY);
  });

  test('shows an error banner when removing the stored key fails', async () => {
    setApiKeyState({
      apiKey: VALID_KEY,
      clearApiKey: jest.fn(() => Promise.reject(new Error('keychain locked'))),
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    const error = await findByTestId('api-key-error');
    expect(error.props.children).toContain('keychain locked');
    alertSpy.mockRestore();
  });

  test('confirms with a status banner when the stored key is removed', async () => {
    setApiKeyState({ apiKey: VALID_KEY });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    const status = await findByTestId('api-key-status');
    expect(status.props.children).toContain('removed from this device');
    alertSpy.mockRestore();
  });

  test('falls back to a default message when saving fails with a blank error', async () => {
    setApiKeyState({ saveApiKey: jest.fn(() => Promise.reject(new Error(''))) });
    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });

    const error = await findByTestId('api-key-error');
    expect(error.props.children).toContain('Could not save the API key.');
  });

  test('falls back to a default message when removing fails with a blank error', async () => {
    setApiKeyState({
      apiKey: VALID_KEY,
      clearApiKey: jest.fn(() => Promise.reject(new Error(''))),
    });
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      const destructive = buttons?.find((b) => b.style === 'destructive');
      destructive?.onPress?.();
    });

    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);
    await act(async () => {
      fireEvent.press(getByTestId('remove-key-button'));
    });

    const error = await findByTestId('api-key-error');
    expect(error.props.children).toContain('Could not remove the API key.');
    alertSpy.mockRestore();
  });

  test('masks a short stored key entirely rather than partially revealing it', () => {
    setApiKeyState({ apiKey: 'sk-short' }); // pragma: allowlist secret
    const { getByText, queryByText } = render(<ApiKeySettingsScreen />);
    expect(getByText('••••••••')).toBeTruthy();
    expect(queryByText(/sk-s/)).toBeNull();
  });

  test('renders a Back link that navigates back when navigation.goBack is provided', () => {
    setApiKeyState({});
    const goBack = jest.fn();
    const { getByLabelText } = render(<ApiKeySettingsScreen navigation={{ goBack }} />);

    fireEvent.press(getByLabelText('Go back'));

    expect(goBack).toHaveBeenCalledTimes(1);
  });

  test('omits the Back and Time zone links when no navigation is supplied', () => {
    setApiKeyState({});
    const { queryByLabelText, queryByTestId } = render(<ApiKeySettingsScreen />);

    expect(queryByLabelText('Go back')).toBeNull();
    expect(queryByTestId('open-timezone-settings')).toBeNull();
  });

  test('surfaces a storage-unavailable warning when loadError is set', () => {
    setApiKeyState({ loadError: new Error('boom') });
    const { getByTestId, queryByText } = render(<ApiKeySettingsScreen />);

    expect(getByTestId('api-key-storage-error').props.children).toBe(SECURE_STORAGE_WARNING);
    expect(queryByText('boom')).toBeNull();
  });

  test('hides the storage warning when loadError is null', () => {
    setApiKeyState({});
    const { queryByTestId } = render(<ApiKeySettingsScreen />);

    expect(queryByTestId('api-key-storage-error')).toBeNull();
  });

  test('shows the storage warning alongside a form submit error', async () => {
    setApiKeyState({ loadError: new Error('x') });
    const { getByTestId, findByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), 'not-a-real-key');
    fireEvent.press(getByTestId('save-key-button'));

    const formError = await findByTestId('api-key-error');
    expect(formError).toBeTruthy();
    expect(getByTestId('api-key-storage-error').props.children).toBe(SECURE_STORAGE_WARNING);
  });

  test('shows only the storage warning, not the success status, when the write does not persist', async () => {
    const state = setApiKeyState({
      loadError: new Error('disk full'),
      saveApiKey: jest.fn(() => Promise.resolve({ persisted: false })),
    });
    const { getByTestId, findByTestId, queryByTestId } = render(<ApiKeySettingsScreen />);

    fireEvent.changeText(getByTestId('api-key-input'), VALID_KEY);
    await act(async () => {
      fireEvent.press(getByTestId('save-key-button'));
    });

    await waitFor(() => expect(state.saveApiKey).toHaveBeenCalledWith(VALID_KEY));
    expect(await findByTestId('api-key-storage-error')).toBeTruthy();
    expect(queryByTestId('api-key-status')).toBeNull();
    expect(queryByTestId('api-key-error')).toBeNull();
    expect(getByTestId('api-key-input').props.value).toBe('');
  });
});
