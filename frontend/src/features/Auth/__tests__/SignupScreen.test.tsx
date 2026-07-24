/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/context/AuthContext', () => {
  const signup = jest.fn(() => Promise.resolve());
  return {
    useAuth: () => ({ signup, token: null }),
    _mockSignup: signup,
  };
});

jest.mock('@/config', () => ({
  API_BASE_URL: 'http://test',
  CONFIG_ERROR: null,
  GUMROAD_PRODUCT_URL: 'https://gumroad.test/l/adepthood',
  GUMROAD_HELP_URL: 'https://gumroad.test/help/license-keys',
}));

jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: jest.fn(() => Promise.resolve(true)),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { _mockSignup: mockSignup } = require('@/context/AuthContext') as any;

import SignupScreen from '../SignupScreen';

import { GUMROAD_HELP_URL } from '@/config';
import { openExternalUrl } from '@/utils/openExternalUrl';

const mockOpenExternalUrl = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;

const LICENSE_LABEL = 'Gumroad license key';
const VALID_LICENSE_KEY = 'A1B2C3D4-E5F6A7B8-C9D0E1F2-A3B4C5D6'; // pragma: allowlist secret
const PASSWORD = 'password123'; // pragma: allowlist secret
const INLINE_ERROR_ID = 'signup-license-error';
const BANNER_ID = 'signup-error';
const HELP_LINK_ID = 'signup-license-help';
const HELP_LINK_LABEL = 'Find your license key';
const HELP_LINK_COPY = "Where's my key?";

const INVALID_LICENSE_COPY =
  "We couldn't verify that key — double-check it matches the email and product.";
const LICENSE_REQUIRED_COPY = 'Add the license key from your Gumroad receipt to continue.';
const TOO_MANY_ATTEMPTS_COPY =
  "That's several tries in a row. Give it an hour, then try again with the key from your receipt.";
const UNAVAILABLE_COPY =
  "We can't reach Gumroad to check your key right now. Nothing is lost — give it a few minutes and try again.";
const PASSWORD_TOO_LONG_COPY =
  'That password is longer than we can store. Shorten it to 64 characters or fewer.';

type Screen = ReturnType<typeof render>;

interface FormValues {
  email?: string;
  password?: string;
  confirmPassword?: string;
  licenseKey?: string;
}

function fillForm(screen: Screen, values: FormValues = {}): void {
  fireEvent.changeText(screen.getByPlaceholderText('Email'), values.email ?? 'new@test.com');
  fireEvent.changeText(screen.getByPlaceholderText('Password'), values.password ?? PASSWORD);
  fireEvent.changeText(
    screen.getByPlaceholderText('Confirm Password'),
    values.confirmPassword ?? values.password ?? PASSWORD,
  );
  if (values.licenseKey !== undefined) {
    fireEvent.changeText(screen.getByLabelText(LICENSE_LABEL), values.licenseKey);
  }
}

function submit(screen: Screen): void {
  fireEvent.press(screen.getByText('Sign Up'));
}

function pressHelpLink(screen: Screen): void {
  fireEvent.press(screen.getByTestId(HELP_LINK_ID));
}

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

  it('renders a labelled Gumroad license key field', () => {
    const { getByLabelText } = render(<SignupScreen navigation={mockNavigation} />);

    expect(getByLabelText(LICENSE_LABEL)).toBeTruthy();
  });

  it('opens on the branded editorial cover: serif wordmark + program voice', () => {
    const { getByTestId, getByText } = render(<SignupScreen navigation={mockNavigation} />);

    expect(getByTestId('auth-brand-band')).toBeTruthy();
    expect(getByText('Adepthood')).toBeTruthy();
    expect(getByText(/thirty-six week/i)).toBeTruthy();
  });

  it('shows the "Begin" serif title', () => {
    const { getByText } = render(<SignupScreen navigation={mockNavigation} />);

    expect(getByText('Begin')).toBeTruthy();
  });

  it('shows error when passwords do not match', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, {
      email: 'user@test.com',
      password: PASSWORD,
      confirmPassword: 'different', // pragma: allowlist secret
      licenseKey: VALID_LICENSE_KEY,
    });
    submit(screen);

    expect(await screen.findByText(/passwords don't match/i)).toBeTruthy();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('shows error when password is too short', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, {
      email: 'user@test.com',
      password: 'short', // pragma: allowlist secret
      licenseKey: VALID_LICENSE_KEY,
    });
    submit(screen);

    expect(await screen.findByText(/at least 8 characters/i)).toBeTruthy();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('calls signup with email, password, and license key on valid submit', async () => {
    mockSignup.mockResolvedValue(undefined);
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { licenseKey: VALID_LICENSE_KEY });
    submit(screen);

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith('new@test.com', PASSWORD, VALID_LICENSE_KEY);
    });
  });

  it('translates backend password_too_short code to user-facing copy', async () => {
    // If the user somehow bypasses the client-side length check (e.g. stale
    // bundle), the backend still enforces it and returns the stable code
    // ``password_too_short``. The screen must not leak snake_case to the UI.
    mockSignup.mockRejectedValue({ detail: 'password_too_short', status: 400 });
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { email: 'taken@test.com', licenseKey: VALID_LICENSE_KEY });
    submit(screen);

    expect(await screen.findByText(/at least 8 characters/i)).toBeTruthy();
    expect(screen.queryByText('password_too_short')).toBeNull();
  });

  it('falls back to a connection-hint message when the error is unrecognised', async () => {
    mockSignup.mockRejectedValue(new TypeError('Network request failed'));
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { email: 'user@test.com', licenseKey: VALID_LICENSE_KEY });
    submit(screen);

    expect(await screen.findByText(/Check your connection/i)).toBeTruthy();
  });

  it('trims whitespace from the email before submitting (BUG-AUTH-010)', async () => {
    mockSignup.mockResolvedValue(undefined);
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { email: '  new@test.com  ', licenseKey: VALID_LICENSE_KEY });
    submit(screen);

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith('new@test.com', PASSWORD, VALID_LICENSE_KEY);
    });
  });

  it('lowercases the email before submitting (audit-ux-08)', async () => {
    // Previously signup submitted email.trim() only, so a "Foo@Bar.com" signup
    // and a "foo@bar.com" login looked like two accounts client-side.
    mockSignup.mockResolvedValue(undefined);
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { email: '  Foo@Bar.COM ', licenseKey: VALID_LICENSE_KEY });
    submit(screen);

    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledWith('foo@bar.com', PASSWORD, VALID_LICENSE_KEY);
    });
  });

  it('renders inside a KeyboardAvoidingView so the keyboard never covers submit', () => {
    const { getByTestId } = render(<SignupScreen navigation={mockNavigation} />);
    expect(getByTestId('signup-keyboard-avoiding')).toBeTruthy();
  });

  it('has a link to navigate to login', () => {
    const { getByText } = render(<SignupScreen navigation={mockNavigation} />);

    fireEvent.press(getByText('Log In'));
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Login');
  });
});

describe('SignupScreen license key validation', () => {
  const mockNavigation = { navigate: jest.fn() };

  it('blocks submit and asks for the key when the field is empty', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { licenseKey: '' });
    submit(screen);

    expect(await screen.findByTestId(INLINE_ERROR_ID)).toHaveTextContent(LICENSE_REQUIRED_COPY);
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('blocks submit when the key is shorter than the backend minimum', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { licenseKey: 'A1B2C3D' });
    submit(screen);

    expect(await screen.findByTestId(INLINE_ERROR_ID)).toBeTruthy();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('sends the trimmed key as the third signup argument', async () => {
    mockSignup.mockResolvedValue(undefined);
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    fillForm(screen, { licenseKey: `   ${VALID_LICENSE_KEY}   ` });
    submit(screen);

    await waitFor(() => expect(mockSignup).toHaveBeenCalledTimes(1));
    expect(mockSignup).toHaveBeenCalledWith('new@test.com', PASSWORD, VALID_LICENSE_KEY);
  });

  it('seeds the field from route.params.licenseKey', () => {
    const { getByLabelText } = render(
      <SignupScreen
        navigation={mockNavigation}
        route={{ params: { licenseKey: VALID_LICENSE_KEY } }}
      />,
    );

    expect(getByLabelText(LICENSE_LABEL).props.value).toBe(VALID_LICENSE_KEY);
  });

  it('renders with navigation alone when no route prop is supplied', () => {
    const { getByLabelText } = render(<SignupScreen navigation={mockNavigation} />);

    expect(getByLabelText(LICENSE_LABEL).props.value).toBe('');
  });
});

describe('SignupScreen license error routing', () => {
  const mockNavigation = { navigate: jest.fn() };

  async function submitWithRejection(detail: unknown, status: number): Promise<Screen> {
    mockSignup.mockRejectedValue({ detail, status });
    const screen = render(<SignupScreen navigation={mockNavigation} />);
    fillForm(screen, { licenseKey: VALID_LICENSE_KEY });
    submit(screen);
    await waitFor(() => expect(mockSignup).toHaveBeenCalledTimes(1));
    return screen;
  }

  const inlineCases: Array<[string, number, string]> = [
    ['invalid_license', 400, INVALID_LICENSE_COPY],
    ['license_required', 400, LICENSE_REQUIRED_COPY],
    ['too_many_license_attempts', 429, TOO_MANY_ATTEMPTS_COPY],
  ];

  const bannerCases: Array<[string, number, string]> = [
    ['license_verification_unavailable', 503, UNAVAILABLE_COPY],
    ['password_too_long', 400, PASSWORD_TOO_LONG_COPY], // pragma: allowlist secret
  ];

  it.each(inlineCases)('renders %p inline on the license field', async (detail, status, copy) => {
    const screen = await submitWithRejection(detail, status);

    const inline = await screen.findByTestId(INLINE_ERROR_ID);
    expect(inline).toHaveTextContent(copy);
    expect(screen.queryByTestId(BANNER_ID)).toBeNull();
  });

  it.each(bannerCases)('renders %p in the generic banner', async (detail, status, copy) => {
    const screen = await submitWithRejection(detail, status);

    const banner = await screen.findByTestId(BANNER_ID);
    expect(banner).toHaveTextContent(copy);
    expect(screen.queryByTestId(INLINE_ERROR_ID)).toBeNull();
  });

  it('announces the inline license error to assistive tech', async () => {
    const screen = await submitWithRejection('invalid_license', 400);

    const inline = await screen.findByTestId(INLINE_ERROR_ID);
    expect(inline.props.accessibilityRole).toBe('alert');
    expect(inline.props.accessibilityLiveRegion).toBe('polite');
  });

  it('clears the inline error as soon as the user edits the key', async () => {
    const screen = await submitWithRejection('invalid_license', 400);
    await screen.findByTestId(INLINE_ERROR_ID);

    fireEvent.changeText(screen.getByLabelText(LICENSE_LABEL), 'B9C8D7E6-F5A4B3C2');

    expect(screen.queryByTestId(INLINE_ERROR_ID)).toBeNull();
  });

  it('shows a readable banner for a Pydantic 422 without leaking field names', async () => {
    const screen = await submitWithRejection('String should have at most 128 characters', 422);

    const banner = await screen.findByTestId(BANNER_ID);
    expect(banner).toBeTruthy();
    expect(screen.queryByText(/license_/)).toBeNull();
    expect(screen.queryByTestId(INLINE_ERROR_ID)).toBeNull();
  });

  // Defensive: if any layer ever forwards the raw Pydantic array through,
  // the screen must still render prose — never ``[object Object]``.
  it('never renders a stringified object when detail is not a string', async () => {
    const screen = await submitWithRejection(
      [{ loc: ['body', 'license_key'], msg: 'Field required', type: 'missing' }],
      422,
    );

    const banner = await screen.findByTestId(BANNER_ID);
    expect(banner).not.toHaveTextContent('[object Object]');
    expect(screen.queryByText(/license_key/)).toBeNull();
  });

  it('keeps the license key out of logs and local storage on a rejected attempt', async () => {
    const spies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const setItem = AsyncStorage.setItem as jest.MockedFunction<typeof AsyncStorage.setItem>;

    const screen = await submitWithRejection('invalid_license', 400);
    await screen.findByTestId(INLINE_ERROR_ID);

    const recorded = [...spies.flatMap((spy) => spy.mock.calls), ...setItem.mock.calls];
    for (const call of recorded) {
      expect(JSON.stringify(call)).not.toContain(VALID_LICENSE_KEY);
    }
    for (const spy of spies) spy.mockRestore();
  });
});

describe('SignupScreen license key help link', () => {
  const mockNavigation = { navigate: jest.fn() };

  beforeEach(() => {
    mockOpenExternalUrl.mockReset();
    mockOpenExternalUrl.mockResolvedValue(true);
  });

  it('renders the help affordance as a labelled link', () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    const link = screen.getByTestId(HELP_LINK_ID);
    expect(link.props.accessibilityRole).toBe('link');
    expect(link.props.accessibilityLabel).toBe(HELP_LINK_LABEL);
    expect(screen.getByText(HELP_LINK_COPY)).toBeTruthy();
  });

  it('opens the help URL from config when pressed', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    pressHelpLink(screen);

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(GUMROAD_HELP_URL);
  });

  it('does not open anything on first render', () => {
    render(<SignupScreen navigation={mockNavigation} />);

    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });

  // The help page is static config. Appending the key would leak a credential
  // into a browser URL bar, history, and any referrer header.
  it('never appends the typed license key to the help URL', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);
    fireEvent.changeText(screen.getByLabelText(LICENSE_LABEL), VALID_LICENSE_KEY);

    pressHelpLink(screen);

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(GUMROAD_HELP_URL);
    expect(JSON.stringify(mockOpenExternalUrl.mock.calls)).not.toContain(VALID_LICENSE_KEY);
  });

  it('stays mounted with no error surfaced when the opener rejects', async () => {
    mockOpenExternalUrl.mockRejectedValue(new Error('no browser available'));
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    pressHelpLink(screen);

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId(HELP_LINK_ID)).toBeTruthy();
    expect(screen.queryByTestId(BANNER_ID)).toBeNull();
    expect(screen.queryByTestId(INLINE_ERROR_ID)).toBeNull();
  });

  it('surfaces no error when the opener resolves false', async () => {
    mockOpenExternalUrl.mockResolvedValue(false);
    const screen = render(<SignupScreen navigation={mockNavigation} />);

    pressHelpLink(screen);

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId(BANNER_ID)).toBeNull();
    expect(screen.queryByTestId(INLINE_ERROR_ID)).toBeNull();
  });

  it('does not submit the form', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);
    fillForm(screen, { licenseKey: VALID_LICENSE_KEY });

    pressHelpLink(screen);

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it('preserves the key the user already typed', async () => {
    const screen = render(<SignupScreen navigation={mockNavigation} />);
    fireEvent.changeText(screen.getByLabelText(LICENSE_LABEL), VALID_LICENSE_KEY);

    pressHelpLink(screen);

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(LICENSE_LABEL).props.value).toBe(VALID_LICENSE_KEY);
  });
});
