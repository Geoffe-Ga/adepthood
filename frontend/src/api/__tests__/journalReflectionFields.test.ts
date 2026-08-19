/* eslint-env jest */
/* global describe, it, expect */

/**
 * Guards two pieces of client/server drift on ``journalMessageSchema``.
 *
 * Both are the same class of bug and neither is loud: Zod strips unknown keys,
 * so a field the backend sends and the schema omits vanishes without an error
 * anywhere. And a `z.enum` at a list boundary fails the *whole* response when a
 * single row carries a value the enum has not heard of.
 */
import { journalListResponseSchema, journalMessageSchema, narrowSender } from '../schemas';

/** A row shaped the way the backend actually serialises one. */
const BACKEND_ROW = {
  id: 1,
  message: 'A page about rivers.',
  sender: 'user',
  timestamp: '2026-06-01T00:00:00Z',
  tag: 'freeform',
  practice_session_id: null,
  user_practice_id: null,
  reflection_level: 'week',
  reflection_scope_key: '2026-W23',
};

describe('journalMessageSchema — reflection fields', () => {
  it('carries reflection_level and reflection_scope_key through validation', () => {
    // Before this schema knew the fields, Zod stripped them and the assertion
    // below read undefined — silently, with the parse still reported as valid.
    const parsed = journalMessageSchema.parse(BACKEND_ROW);
    expect(parsed.reflection_level).toBe('week');
    expect(parsed.reflection_scope_key).toBe('2026-W23');
  });

  it('still parses a row predating the columns', () => {
    const older: Record<string, unknown> = { ...BACKEND_ROW };
    delete older.reflection_level;
    delete older.reflection_scope_key;
    const parsed = journalMessageSchema.parse(older);
    expect(parsed.reflection_level).toBeUndefined();
    expect(parsed.reflection_scope_key).toBeUndefined();
  });

  it('accepts an explicit null, which is what the backend sends when unset', () => {
    const parsed = journalMessageSchema.parse({
      ...BACKEND_ROW,
      reflection_level: null,
      reflection_scope_key: null,
    });
    expect(parsed.reflection_level).toBeNull();
    expect(parsed.reflection_scope_key).toBeNull();
  });
});

describe('journalMessageSchema — sender', () => {
  it('does not fail the whole list when one row has an unrecognised sender', () => {
    // The backend types sender as a bare `str`, so a third value is a schema
    // change away. With a z.enum here that would have taken down every other
    // row in the response with it — the failure mode narrowTier exists to stop.
    const parsed = journalListResponseSchema.parse({
      items: [BACKEND_ROW, { ...BACKEND_ROW, id: 2, sender: 'oracle' }],
      total: 2,
      has_more: false,
    });
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[1]?.sender).toBe('oracle');
  });

  it('narrows a known sender and falls back for anything else', () => {
    expect(narrowSender('user')).toBe('user');
    expect(narrowSender('bot')).toBe('bot');
    // Falls back to 'bot' rather than 'user': an unknown speaker is not the
    // person writing, and attributing someone else's words to them is the worse
    // of the two wrong answers.
    expect(narrowSender('oracle')).toBe('bot');
    expect(narrowSender('')).toBe('bot');
  });

  it('still rejects a row whose sender is not a string at all', () => {
    // Loosened, not abandoned: the field must still be present and a string.
    expect(() => journalMessageSchema.parse({ ...BACKEND_ROW, sender: 7 })).toThrow();
  });
});
