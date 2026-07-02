/* eslint-env jest */
/* global describe, it, expect */

/**
 * Verifies that the ``classification`` field on ``journalMessageSchema`` and the
 * ``private`` / ``private_message`` fields on ``resonanceResponseSchema`` parse
 * correctly. The fields are backward-compatible: payloads without them still
 * parse, and payloads with them round-trip.
 */
import { journalMessageSchema, resonanceResponseSchema } from '../schemas';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal valid journal message without the new classification field. */
const BASE_JOURNAL_MESSAGE = {
  id: 1,
  message: 'A page about rivers.',
  sender: 'user' as const,
  timestamp: '2026-06-01T00:00:00Z',
  tag: 'freeform' as const,
  practice_session_id: null,
  user_practice_id: null,
};

/** Minimal valid resonance response without the new private fields. */
const BASE_RESONANCE = {
  marginalia: [],
  suggestions: [],
  remaining_messages: 48,
  remaining_balance: 0,
  monthly_reset_date: '2026-07-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// journalMessageSchema — classification field (additive)
// ---------------------------------------------------------------------------

describe('journalMessageSchema — classification field (issue #896)', () => {
  it('still parses a message WITHOUT classification (backward-compat)', () => {
    // Existing API responses that predate #896 omit this field; they must not fail.
    expect(() => journalMessageSchema.parse(BASE_JOURNAL_MESSAGE)).not.toThrow();
  });

  it('parses a message with classification="personal"', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'personal' };
    expect(() => journalMessageSchema.parse(payload)).not.toThrow();
  });

  it('parses a message with classification="public"', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'public' };
    expect(() => journalMessageSchema.parse(payload)).not.toThrow();
  });

  it('parses a message with classification="intimate"', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'intimate' };
    expect(() => journalMessageSchema.parse(payload)).not.toThrow();
  });

  it('round-trips classification="intimate" exactly', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'intimate' as const };
    const parsed = journalMessageSchema.parse(payload);
    expect(parsed.classification).toBe('intimate');
  });

  it('round-trips classification="personal" exactly', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'personal' as const };
    const parsed = journalMessageSchema.parse(payload);
    expect(parsed.classification).toBe('personal');
  });

  it('round-trips classification="public" exactly', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'public' as const };
    const parsed = journalMessageSchema.parse(payload);
    expect(parsed.classification).toBe('public');
  });

  it('rejects an unknown classification value (type drift)', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 'secret' };
    expect(() => journalMessageSchema.parse(payload)).toThrow();
  });

  it('rejects a numeric classification (type drift)', () => {
    const payload = { ...BASE_JOURNAL_MESSAGE, classification: 2 };
    expect(() => journalMessageSchema.parse(payload)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resonanceResponseSchema — private + private_message fields (additive)
// ---------------------------------------------------------------------------

describe('resonanceResponseSchema — private / private_message fields (issue #896)', () => {
  it('still parses a response WITHOUT private or private_message (backward-compat)', () => {
    // All existing resonance responses omit these; they must continue to parse.
    expect(() => resonanceResponseSchema.parse(BASE_RESONANCE)).not.toThrow();
  });

  it('parses a response with private=false and no private_message', () => {
    const payload = { ...BASE_RESONANCE, private: false };
    expect(() => resonanceResponseSchema.parse(payload)).not.toThrow();
  });

  it('parses a response with private=true and a private_message string', () => {
    const payload = {
      ...BASE_RESONANCE,
      private: true,
      private_message: 'This entry is intimate — resonance is paused.',
    };
    expect(() => resonanceResponseSchema.parse(payload)).not.toThrow();
  });

  it('parses a response with private=true and private_message=null', () => {
    const payload = { ...BASE_RESONANCE, private: true, private_message: null };
    expect(() => resonanceResponseSchema.parse(payload)).not.toThrow();
  });

  it('round-trips private=true exactly', () => {
    const payload = { ...BASE_RESONANCE, private: true, private_message: 'Intimate entry.' };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.private).toBe(true);
  });

  it('round-trips private_message string exactly', () => {
    const msg = 'This entry is intimate — resonance is paused.';
    const payload = { ...BASE_RESONANCE, private: true, private_message: msg };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.private_message).toBe(msg);
  });

  it('round-trips private=false with no private_message', () => {
    const payload = { ...BASE_RESONANCE, private: false };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.private).toBe(false);
  });

  it('rejects a string value for the private field (type drift)', () => {
    const payload = { ...BASE_RESONANCE, private: 'yes' };
    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a numeric value for private_message (type drift)', () => {
    const payload = { ...BASE_RESONANCE, private: true, private_message: 42 };
    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });
});
