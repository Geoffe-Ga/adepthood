/**
 * A managed vault that writes with the writer's own key: priced, labelled and
 * relayed only when the server said so (#3437, ADR 0009 2026-10-16 amendment).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import PassReceiptNotice from '../PassReceiptNotice';
import { loadCostState } from '../resonanceCost';
import { vaultKeyCost, vaultKeyReceiptLabel, vaultKeyVendorFor } from '../vaultKeyCopy';

import type { BotmasonUsageT, PassProvenanceT } from '@/api/schemas';

const mockUsage = jest.fn<() => Promise<BotmasonUsageT>>();
const mockVendors = jest.fn<() => Promise<readonly ('anthropic' | 'openai')[]>>();
jest.mock('@/api', () => ({
  botmasonUsage: { get: () => mockUsage() },
  vaultRequestKeys: { get: () => mockVendors() },
}));

const EMPTY_WALLET = {
  resonance_route: 'vault_bound' as const,
  monthly_messages_used: 20,
  monthly_messages_remaining: 0,
  monthly_cap: 20,
  monthly_reset_date: '2026-11-01T00:00:00Z',
  offering_balance: 0,
};

const ANTHROPIC_KEY = 'sk-ant-api03-abcdef1234567890'; // pragma: allowlist secret
const OPENAI_KEY = 'sk-proj-abcdef1234567890'; // pragma: allowlist secret

beforeEach(() => {
  mockUsage.mockReset();
  mockVendors.mockReset();
  mockUsage.mockResolvedValue(EMPTY_WALLET);
});

describe('the price line before a vault reading or letter (#3437)', () => {
  it.each(['reading', 'letter'])(
    'says the writer’s own key pays a %s their managed vault writes with it',
    async (noun) => {
      mockVendors.mockResolvedValue(['anthropic', 'openai']);

      const result = await loadCostState(true, noun, undefined, 'anthropic');

      expect(result.copy).toBe(vaultKeyCost('anthropic', noun));
      expect(result.copy).toContain('Written by your own Anthropic key, through your vault');
      expect(result.canContinue).toBe(true);
      expect(result.fundingRequired).toBeNull();
      expect(result.route).toBe('vault_bound');
    },
  );

  it('keeps the credit price when the vault does not write with that vendor', async () => {
    mockVendors.mockResolvedValue(['anthropic']);

    const result = await loadCostState(true, 'reading', undefined, 'openai');

    expect(result.canContinue).toBe(false);
    expect(result.fundingRequired).toBe('wallet_exhausted');
    expect(result.copy).not.toMatch(/through your vault/u);
  });

  it('keeps the credit price when the vendor read fails', async () => {
    mockVendors.mockRejectedValue(new Error('vault unreachable'));

    const result = await loadCostState(true, 'reading', undefined, 'anthropic');

    expect(result.fundingRequired).toBe('wallet_exhausted');
    expect(result.copy).not.toMatch(/through your vault/u);
  });

  it('never asks the vault, or presents a key as paying, without one', async () => {
    mockVendors.mockResolvedValue(['anthropic']);

    const result = await loadCostState(false, 'reading', undefined, 'anthropic');

    expect(result.copy).not.toMatch(/your own/u);
    expect(mockVendors).not.toHaveBeenCalled();
  });

  it('never asks the vault for an app-provider writer', async () => {
    mockUsage.mockResolvedValue({ ...EMPTY_WALLET, resonance_route: 'app_provider' });

    await loadCostState(true, 'reading', undefined, 'anthropic');

    expect(mockVendors).not.toHaveBeenCalled();
  });
});

describe('the per-use label after the pass (#3437)', () => {
  const pass = (overrides: Partial<PassProvenanceT>): PassProvenanceT => ({
    notes: { source: 'creek_vault', provider: 'creek', receipt_version: 1 },
    detection: { source: 'none', receipt_version: 1 },
    detection_checked: false,
    paid_by: 'own_key',
    own_key_vendor: null,
    ...overrides,
  });

  it.each<['anthropic' | 'openai', string]>([
    ['anthropic', 'Written by your own Anthropic key, through your vault'],
    ['openai', 'Written by your own OpenAI key, through your vault'],
  ])('names the %s key the vault wrote with', (vendor, label) => {
    const { getByTestId } = render(
      <PassReceiptNotice provenance={pass({ own_key_vendor: vendor })} empty={false} />,
    );

    expect(getByTestId('resonance-pass-payer').props.children).toBe(label);
    expect(vaultKeyReceiptLabel(vendor)).toBe(label);
  });

  it('keeps the plain key label when no vault wrote with it', () => {
    const { getByTestId } = render(
      <PassReceiptNotice provenance={pass({ own_key_vendor: null })} empty={false} />,
    );

    expect(getByTestId('resonance-pass-payer').props.children).toBe('Your provider key');
  });
});

describe('a stored key’s vendor', () => {
  it.each<[string | null, 'anthropic' | 'openai' | null]>([
    [ANTHROPIC_KEY, 'anthropic'],
    [OPENAI_KEY, 'openai'],
    [null, null],
    ['not-a-key', null],
  ])('reads %s as %s', (key, vendor) => {
    expect(vaultKeyVendorFor(key)).toBe(vendor);
  });
});
