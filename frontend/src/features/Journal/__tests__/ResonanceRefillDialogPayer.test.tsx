/* eslint-env jest */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import ResonanceRefillDialog from '../ResonanceRefillDialog';

const PACK_URL = 'https://creekmasons.gumroad.com/l/botmason-credits';

// The pack page is configuration with no default (#3262); each test decides it.
let mockCreditPackUrl = '';
jest.mock('@/config', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/config');
  // `defineProperty` so the value is read at each access, not frozen at require.
  return Object.defineProperty({ ...actual }, 'CREDIT_PACK_URL', {
    enumerable: true,
    get: (): string => mockCreditPackUrl,
  });
});

const mockOpenExternalUrl = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

/**
 * A resonance pass with no personal key and no credits is refused before
 * anything is spent (#3096). The refill dialog is that refusal's surface, so it
 * names the ways forward and says the writer was not charged. Credits are one
 * of those ways only when there is a page to buy them on (#3262).
 */
function renderDialog(reason: 'wallet_exhausted' | 'key_required') {
  return render(
    <ResonanceRefillDialog
      visible
      monthlyResetDate={null}
      monthlyCap={null}
      reason={reason}
      onAddKey={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
}

beforeEach(() => {
  mockCreditPackUrl = '';
  mockOpenExternalUrl.mockClear();
});

describe('ResonanceRefillDialog — a refused pass says how to proceed', () => {
  it('an empty vault wallet names credits and says nothing was charged', () => {
    const { getByText } = renderDialog('wallet_exhausted');

    expect(getByText(/BotMason balance has run out/u)).toBeTruthy();
    expect(
      getByText(/vault answers use BotMason credits, even when an API key is saved/u),
    ).toBeTruthy();
    expect(getByText(/nothing was charged/iu)).toBeTruthy();
  });

  it('a missing key says nothing was charged', () => {
    const { getByText } = renderDialog('key_required');

    expect(getByText(/needs an API key of your own/u)).toBeTruthy();
    expect(getByText(/nothing was charged/iu)).toBeTruthy();
  });
});

describe('ResonanceRefillDialog — credits are offered only with a pack page (#3262)', () => {
  it('says nothing about buying credits while the pack page is unset', () => {
    const { getByTestId, queryByTestId } = renderDialog('wallet_exhausted');

    expect(getByTestId('journal-resonance-refill-card')).not.toHaveTextContent(
      /add more BotMason credits|Buy BotMason credits/u,
    );
    expect(queryByTestId('journal-resonance-refill-credit-pack')).toBeNull();
  });

  it('offers no link for a pack page that is not https', () => {
    mockCreditPackUrl = 'http://creekmasons.gumroad.com/l/botmason-credits';
    const { queryByTestId } = renderDialog('wallet_exhausted');

    expect(queryByTestId('journal-resonance-refill-credit-pack')).toBeNull();
  });

  it('links to the pack page, with the same-email note, once it is set', () => {
    mockCreditPackUrl = PACK_URL;
    const { getByTestId, getByText } = renderDialog('wallet_exhausted');

    expect(getByText(/vault answers use BotMason credits/u)).toBeTruthy();
    expect(
      getByText(
        'Use the same email address as your Adepthood account when you buy, so the credits reach you.',
      ),
    ).toBeTruthy();
    expect(getByTestId('journal-resonance-refill-credit-pack-link')).toHaveTextContent(
      'Buy BotMason credits',
    );
    fireEvent.press(getByTestId('journal-resonance-refill-credit-pack-link'));
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(PACK_URL);
  });

  it('never offers credits where only a key can help', () => {
    mockCreditPackUrl = PACK_URL;
    const { getByTestId, queryByTestId } = renderDialog('key_required');

    expect(queryByTestId('journal-resonance-refill-credit-pack')).toBeNull();
    expect(getByTestId('journal-resonance-refill-card')).not.toHaveTextContent(/credits/u);
  });
});

it('never offers a key as an alternative payer for an exhausted vault reading', () => {
  const { queryByTestId } = renderDialog('wallet_exhausted');
  expect(queryByTestId('journal-resonance-refill-add-key')).toBeNull();
});
