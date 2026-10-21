/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { Marginalia } from '@/api';
import type { BotmasonUsageT as UsageResponse } from '@/api/schemas';
import { setActiveUser } from '@/storage/userScope';

/**
 * A vault-bound first letter priced against an empty wallet (#3386).
 *
 * The offer already knows, before any ask, that nothing can pay for the letter,
 * so it offers no Ask, and no POST can come back 402 to open the refill dialog.
 * The remedy that dialog carries -- when the balance returns, and the credit
 * pack page where one is configured -- therefore has to be on the offer itself.
 * A saved key changes nothing here: the vault writes the letter and never uses it.
 */

const PACK_URL = 'https://creekmasons.gumroad.com/l/botmason-credits';

let mockCreditPackUrl = '';
jest.mock('@/config', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/config');
  return Object.defineProperty({ ...actual }, 'CREDIT_PACK_URL', {
    enumerable: true,
    get: (): string => mockCreditPackUrl,
  });
});

const mockOpenExternalUrl = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

const mockEssay = jest.fn() as jest.MockedFunction<(..._a: unknown[]) => Promise<Marginalia>>;
const mockUsage = jest.fn() as jest.MockedFunction<(_token?: string) => Promise<UsageResponse>>;
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: { essay: (...a: unknown[]) => mockEssay(...a) },
    botmasonUsage: { get: (token?: string) => mockUsage(token) },
  };
});

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    token: 'test.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test',
    authStatus: 'authenticated',
  }),
}));

const ResonanceEssayModal = require('../ResonanceEssayModal').default;

const NOTE: Marginalia = {
  id: 4,
  journal_entry_id: 1,
  kind: 'connection',
  anchor_start: 0,
  anchor_end: 6,
  anchor_text: 'willow',
  note: 'It bends.',
  essay: null,
  essay_generated_at: null,
  status: 'active',
  created_at: '',
  updated_at: '',
};

const EXHAUSTED = 'You have no BotMason monthly messages or offerings available for this letter.';
const VAULT_USES_CREDITS =
  'Letters your vault writes use BotMason credits, even when an API key is saved.';

/** A vault-bound wallet: ``cap`` monthly messages with ``remaining`` left, plus offerings. */
function vaultUsage(cap: number, remaining: number, offerings: number): UsageResponse {
  return {
    monthly_messages_used: cap - remaining,
    monthly_messages_remaining: remaining,
    monthly_cap: cap,
    monthly_reset_date: '2026-11-01T00:00:00Z',
    offering_balance: offerings,
    resonance_route: 'vault_bound',
  };
}

function renderOffer(hasOwnKey: boolean, overrides: Partial<Marginalia> = {}) {
  const onClose = jest.fn();
  const onOpenSettings = jest.fn();
  const onFundingRequired = jest.fn();
  const view = render(
    <ResonanceEssayModal
      note={{ ...NOTE, ...overrides }}
      onClose={onClose}
      hasOwnKey={hasOwnKey}
      onOpenSettings={onOpenSettings}
      onFundingRequired={onFundingRequired}
    />,
  );
  return { ...view, onClose, onOpenSettings, onFundingRequired };
}

beforeEach(() => {
  setActiveUser(1);
  mockCreditPackUrl = '';
  mockOpenExternalUrl.mockClear();
  mockEssay.mockReset();
  mockUsage.mockReset();
});

describe('an exhausted letter wallet offers its remedy before any ask (#3386)', () => {
  it.each<[string, number, boolean, string, string]>([
    // The monthly allowance and the paid offerings both spent.
    ['allowance and offerings', 20, false, '', 'Your BotMason messages reset on November 1, 2026.'],
    [
      'allowance and offerings',
      20,
      true,
      PACK_URL,
      'Your BotMason messages reset on November 1, 2026.',
    ],
    // An offerings-only account: nothing resets monthly to refill it.
    ['offerings only', 0, false, PACK_URL, 'Your next monthly reset is November 1, 2026.'],
    ['offerings only', 0, true, '', 'Your next monthly reset is November 1, 2026.'],
  ])(
    'spent %s (cap %d), key=%s, pack=%j: names the reset and the pack, asks nothing',
    async (_label, cap, hasOwnKey, packUrl, resetLine) => {
      mockCreditPackUrl = packUrl;
      mockUsage.mockResolvedValue(vaultUsage(cap, 0, 0));
      const view = renderOffer(hasOwnKey);

      await waitFor(() => expect(view.getByTestId('essay-ask-cost')).toHaveTextContent(EXHAUSTED));
      const remedy = view.getByTestId('essay-wallet-remedy');
      expect(remedy).toHaveTextContent(resetLine, { exact: false });
      expect(remedy).toHaveTextContent(VAULT_USES_CREDITS, { exact: false });
      // No arm promises that a key, or an ask, could pay for this letter.
      expect(view.queryByTestId('essay-ask')).toBeNull();
      expect(view.queryByTestId('essay-open-settings')).toBeNull();
      expect(view.getByTestId('essay-offer')).not.toHaveTextContent(/You can ask now/u);

      const pack = view.queryByTestId('essay-credit-pack-link');
      const cancel = view.getByTestId('essay-not-now');
      if (packUrl) {
        expect(pack).toHaveTextContent('Buy BotMason credits');
        expect(pack?.props.accessibilityRole).toBe('link');
        expect(remedy).toHaveTextContent(
          'Use the same email address as your Adepthood account when you buy, so the credits reach you.',
          { exact: false },
        );
        fireEvent.press(pack!);
        expect(mockOpenExternalUrl).toHaveBeenCalledWith(PACK_URL);
        expect(cancel.props.accessibilityLabel).toBe('Not now — close without buying credits');
      } else {
        expect(pack).toBeNull();
        expect(view.getByTestId('essay-offer')).not.toHaveTextContent(/buy|credit pack/iu);
        expect(cancel.props.accessibilityLabel).toBe('Not now — close this message');
      }

      await act(async () => {
        fireEvent.press(cancel);
      });
      expect(view.onClose).toHaveBeenCalledTimes(1);
      expect(view.onOpenSettings).not.toHaveBeenCalled();
      expect(view.onFundingRequired).not.toHaveBeenCalled();
      expect(mockEssay).not.toHaveBeenCalled();
    },
  );

  it('offers the ordinary ask, with no remedy, once a balance is back', async () => {
    mockCreditPackUrl = PACK_URL;
    mockUsage.mockResolvedValue(vaultUsage(20, 0, 2));
    const view = renderOffer(true);

    await waitFor(() => expect(view.getByTestId('essay-ask')).toBeTruthy());
    expect(view.getByTestId('essay-ask-cost')).toHaveTextContent(
      'This letter spends one BotMason offering.',
    );
    expect(view.queryByTestId('essay-wallet-remedy')).toBeNull();
    expect(view.queryByTestId('essay-credit-pack-link')).toBeNull();
    expect(view.getByTestId('essay-not-now').props.accessibilityLabel).toBe(
      'Not now — do not write this letter',
    );
  });

  it('opens a letter already written straight to the letter, with no remedy and no wallet read', async () => {
    mockCreditPackUrl = PACK_URL;
    mockUsage.mockResolvedValue(vaultUsage(20, 0, 0));
    const view = renderOffer(false, { essay: 'Kept, and free to reopen.' });

    await act(async () => {});
    expect(view.getByTestId('essay-text')).toHaveTextContent('Kept, and free to reopen.');
    expect(view.queryByTestId('essay-wallet-remedy')).toBeNull();
    expect(mockUsage).not.toHaveBeenCalled();
    expect(mockEssay).not.toHaveBeenCalled();
  });
});
