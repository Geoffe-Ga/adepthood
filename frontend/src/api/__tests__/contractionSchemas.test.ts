/* eslint-env jest */
/* global describe, it, expect */

/**
 * RED tests for the ``contraction`` field on ``resonanceResponseSchema``.
 *
 * Backend delivers ``contraction: { variant, message } | null`` on the journal
 * resonance-pass response, defaulted None (absent on the wire) for healthy or
 * new users. ``variant`` is exactly one of ``simple_ease_off`` |
 * ``return_offer``. This must be additive: a response omitting ``contraction``
 * (all existing callers) still parses and behaves exactly as before.
 */
import { resonanceResponseSchema } from '../schemas';

/** Minimal valid resonance response without the new contraction field. */
const BASE_RESONANCE = {
  marginalia: [],
  suggestions: [],
  remaining_messages: 48,
  remaining_balance: 0,
  monthly_reset_date: '2026-07-01T00:00:00Z',
};

describe('resonanceResponseSchema — contraction field (backward-compat)', () => {
  it('still parses a response WITHOUT contraction', () => {
    const parsed = resonanceResponseSchema.parse(BASE_RESONANCE);
    expect(parsed.contraction == null).toBe(true);
  });

  it('parses a response with contraction: null', () => {
    const payload = { ...BASE_RESONANCE, contraction: null };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.contraction).toBeNull();
  });
});

describe('resonanceResponseSchema — contraction field (round-trip)', () => {
  it('round-trips a simple_ease_off contraction message exactly', () => {
    const message = 'Your practice has eased off a little. No rush back.';
    const payload = {
      ...BASE_RESONANCE,
      contraction: { variant: 'simple_ease_off', message },
    };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.contraction!.variant).toBe('simple_ease_off');
    expect(parsed.contraction!.message).toBe(message);
  });

  it('round-trips a return_offer contraction message exactly', () => {
    const message = 'It has been a while. A five-week Return is here whenever you want it.';
    const payload = {
      ...BASE_RESONANCE,
      contraction: { variant: 'return_offer', message },
    };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.contraction!.variant).toBe('return_offer');
    expect(parsed.contraction!.message).toBe(message);
  });
});

describe('resonanceResponseSchema — contraction field (rejects drift)', () => {
  it('rejects an unknown variant', () => {
    const payload = {
      ...BASE_RESONANCE,
      contraction: { variant: 'demotion', message: 'Some copy.' },
    };
    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a contraction object missing message', () => {
    const payload = {
      ...BASE_RESONANCE,
      contraction: { variant: 'simple_ease_off' },
    };
    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a non-string message', () => {
    const payload = {
      ...BASE_RESONANCE,
      contraction: { variant: 'simple_ease_off', message: 42 },
    };
    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });
});
