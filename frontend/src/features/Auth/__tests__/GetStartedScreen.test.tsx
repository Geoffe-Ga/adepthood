/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

const PRODUCT_URL = 'https://gumroad.test/l/adepthood';

jest.mock('@/config', () => ({
  API_BASE_URL: 'http://test',
  CONFIG_ERROR: null,
  GUMROAD_PRODUCT_URL: 'https://gumroad.test/l/adepthood',
  GUMROAD_HELP_URL: 'https://gumroad.test/help/license-keys',
}));

jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: jest.fn(() => Promise.resolve(true)),
}));

import GetStartedScreen from '../GetStartedScreen';

import { openExternalUrl } from '@/utils/openExternalUrl';

const mockOpenExternalUrl = openExternalUrl as jest.MockedFunction<typeof openExternalUrl>;

const BUY_LABEL = 'Get Adepthood on Gumroad';
const HAVE_KEY_LABEL = 'I have a license key';

const mockNavigation = { navigate: jest.fn() };

beforeEach(() => {
  mockOpenExternalUrl.mockResolvedValue(true);
});

describe('GetStartedScreen', () => {
  it('is the pre-auth surface, identified by its own screen testID', () => {
    const { getByTestId } = render(<GetStartedScreen navigation={mockNavigation} />);

    expect(getByTestId('get-started-screen')).toBeTruthy();
  });

  it('leads with the gift-economy framing rather than a price', () => {
    const { getByText } = render(<GetStartedScreen navigation={mockNavigation} />);

    expect(getByText(/pay what feels right/i)).toBeTruthy();
    expect(getByText(/starting at zero/i)).toBeTruthy();
  });

  it('opens the Gumroad product page from config when the buy CTA is pressed', async () => {
    const { getByText } = render(<GetStartedScreen navigation={mockNavigation} />);

    fireEvent.press(getByText(BUY_LABEL));

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(PRODUCT_URL);
  });

  it('stays mounted when the opener rejects instead of crashing the screen', async () => {
    mockOpenExternalUrl.mockRejectedValue(new Error('no browser available'));
    const { getByText, getByTestId } = render(<GetStartedScreen navigation={mockNavigation} />);

    fireEvent.press(getByText(BUY_LABEL));

    await waitFor(() => expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1));
    expect(getByTestId('get-started-screen')).toBeTruthy();
    expect(getByText(BUY_LABEL)).toBeTruthy();
  });

  it('routes buyers who already have a key to the signup form', () => {
    const { getByText } = render(<GetStartedScreen navigation={mockNavigation} />);

    fireEvent.press(getByText(HAVE_KEY_LABEL));

    expect(mockNavigation.navigate).toHaveBeenCalledWith('Signup');
  });

  // GetStarted replaces Login as the initial anonymous route, so returning
  // users need an explicit way back to the log-in form from here.
  it('routes returning users to the log-in form', () => {
    const { getByText } = render(<GetStartedScreen navigation={mockNavigation} />);

    fireEvent.press(getByText('Log In'));

    expect(mockNavigation.navigate).toHaveBeenCalledWith('Login');
  });

  it('exposes both primary CTAs to assistive tech as buttons', () => {
    const { getByLabelText } = render(<GetStartedScreen navigation={mockNavigation} />);

    expect(getByLabelText(BUY_LABEL).props.accessibilityRole).toBe('button');
    expect(getByLabelText(HAVE_KEY_LABEL).props.accessibilityRole).toBe('button');
  });

  it('does not open anything on first render', () => {
    render(<GetStartedScreen navigation={mockNavigation} />);

    expect(mockOpenExternalUrl).not.toHaveBeenCalled();
  });
});
