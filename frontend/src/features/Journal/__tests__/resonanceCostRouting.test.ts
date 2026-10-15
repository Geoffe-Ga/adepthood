import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { loadCostState } from '../resonanceCost';

import type { BotmasonUsageT } from '@/api/schemas';

const mockUsage = jest.fn<() => Promise<BotmasonUsageT>>();
jest.mock('@/api', () => ({ botmasonUsage: { get: () => mockUsage() } }));

const USAGE = {
  monthly_messages_used: 0,
  monthly_messages_remaining: 20,
  monthly_cap: 20,
  monthly_reset_date: '2026-11-01T00:00:00Z',
  offering_balance: 3,
};

beforeEach(() => {
  mockUsage.mockReset();
});

describe('server-reported reading payment route (#3262/#3281)', () => {
  it.each(['reading', 'letter'])(
    'offers the explicitly available keyless demo %s without a wallet price',
    async (noun) => {
      mockUsage.mockResolvedValue({
        ...USAGE,
        resonance_route: 'app_provider',
        resonance_demo_available: true,
      });
      const result = await loadCostState(false, noun);
      expect(result.copy).toBe('Demo — not a real reflection. No Adepthood wallet charge.');
      expect(result.canContinue).toBe(true);
      expect(result.keyNeeded).toBe(false);
      expect(result.fundingRequired).toBeNull();
      expect(result.copy).not.toMatch(/spends|your vault|BotMason/u);
    },
  );
  it('admits a demo reservation from offerings when monthly messages are exhausted', async () => {
    mockUsage.mockResolvedValue({
      ...USAGE,
      resonance_route: 'app_provider',
      resonance_demo_available: true,
      monthly_messages_remaining: 0,
      offering_balance: 1,
    });
    expect((await loadCostState(false)).canContinue).toBe(true);
  });
  it('still offers only Settings when the demo reservation cannot be admitted', async () => {
    mockUsage.mockResolvedValue({
      ...USAGE,
      resonance_route: 'app_provider',
      resonance_demo_available: true,
      monthly_messages_remaining: 0,
      offering_balance: 0,
    });
    const result = await loadCostState(false);
    expect(result.canContinue).toBe(false);
    expect(result.fundingRequired).toBe('key_required');
    expect(result.copy).not.toMatch(/demo|offering|BotMason/iu);
  });
  it('keeps the own key as payer even while a keyless demo is available', async () => {
    mockUsage.mockResolvedValue({
      ...USAGE,
      resonance_route: 'app_provider',
      resonance_demo_available: true,
    });
    const result = await loadCostState(true);
    expect(result.copy).toMatch(/^Your own API key pays/u);
    expect(result.copy).not.toMatch(/demo/iu);
  });
  it('never applies the demo capability to a vault-bound route', async () => {
    mockUsage.mockResolvedValue({
      ...USAGE,
      resonance_route: 'vault_bound',
      resonance_demo_available: true,
    });
    expect((await loadCostState(false)).copy).toBe(
      'This reading spends one of your 20 BotMason messages for the month.',
    );
  });
  it('keeps the own-key app-provider copy, after checking the actual route', async () => {
    mockUsage.mockResolvedValue({ ...USAGE, resonance_route: 'app_provider' });
    const result = await loadCostState(true);
    expect(result.copy).toBe(
      'Your own API key pays for this reading. Nothing is drawn from your BotMason messages.',
    );
    expect(result.canContinue).toBe(true);
    expect(mockUsage).toHaveBeenCalledTimes(1);
  });
  it('requires a key for an app-provider reading even when credits remain', async () => {
    mockUsage.mockResolvedValue({ ...USAGE, resonance_route: 'app_provider' });
    const result = await loadCostState(false);
    expect(result.copy).toMatch(/^This needs your own API key/u);
    expect(result.canContinue).toBe(false);
    expect(result.fundingRequired).toBe('key_required');
    expect(result.copy).not.toMatch(/BotMason|spends/u);
  });
  it.each([false, true])('charges a vault route from credits, own key=%s', async (hasKey) => {
    mockUsage.mockResolvedValue({ ...USAGE, resonance_route: 'vault_bound' });
    const result = await loadCostState(hasKey);
    expect(result.copy).toBe('This reading spends one of your 20 BotMason messages for the month.');
    expect(result.canContinue).toBe(true);
    expect(result.fundingRequired).toBeNull();
  });
  it.each([false, true])(
    'offers a wallet remedy for an empty vault route, own key=%s',
    async (hasKey) => {
      mockUsage.mockResolvedValue({
        ...USAGE,
        resonance_route: 'vault_bound',
        monthly_messages_remaining: 0,
        offering_balance: 0,
      });
      const result = await loadCostState(hasKey);
      expect(result.canContinue).toBe(false);
      expect(result.fundingRequired).toBe('wallet_exhausted');
      expect(result.copy).not.toMatch(/key.*pays|pays instead/u);
    },
  );
  it.each([false, true])(
    'offers a vault-written letter at its wallet price, own key=%s',
    async (hasKey) => {
      mockUsage.mockResolvedValue({ ...USAGE, resonance_route: 'vault_bound' });
      const result = await loadCostState(hasKey, 'letter');
      expect(result.copy).toBe(
        'This letter spends one of your 20 BotMason messages for the month.',
      );
      expect(result.canContinue).toBe(true);
      expect(result.keyNeeded).toBe(false);
      expect(result.fundingRequired).toBeNull();
    },
  );
  it.each([false, true])(
    'requires wallet funding for a vault letter even with a key, own key=%s',
    async (hasKey) => {
      mockUsage.mockResolvedValue({
        ...USAGE,
        resonance_route: 'vault_bound',
        monthly_messages_remaining: 0,
        offering_balance: 0,
      });
      const result = await loadCostState(hasKey, 'letter');
      expect(result.canContinue).toBe(false);
      expect(result.keyNeeded).toBe(false);
      expect(result.fundingRequired).toBe('wallet_exhausted');
      expect(result.copy).not.toMatch(/key.*pays|not available/u);
    },
  );
  it.each([false, true])(
    'checks the route for an app-provider letter, own key=%s',
    async (hasKey) => {
      mockUsage.mockResolvedValue({ ...USAGE, resonance_route: 'app_provider' });
      const result = await loadCostState(hasKey, 'letter');
      expect(mockUsage).toHaveBeenCalledTimes(1);
      expect(result.canContinue).toBe(hasKey);
      expect(result.fundingRequired).toBe(hasKey ? null : 'key_required');
    },
  );
  it.each([false, true])(
    'does not infer an unknown route from a key or wallet, own key=%s',
    async (hasKey) => {
      mockUsage.mockRejectedValue(new Error('Usage response failed validation'));
      const result = await loadCostState(hasKey);
      expect(result.canContinue).toBe(false);
      expect(result.fundingRequired).toBeNull();
      expect(result.copy).toMatch(/couldn't check how this reading would be paid for/u);
      expect(result.copy).not.toMatch(/key pays|spends/u);
    },
  );
});
