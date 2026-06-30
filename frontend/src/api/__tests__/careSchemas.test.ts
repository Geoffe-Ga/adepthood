/* eslint-env jest */
/* global describe, it, expect */

/**
 * RED tests for ``careResourceSchema`` / ``careResponseSchema`` /
 * ``resonanceResponseSchema`` (issue #891).
 *
 * These tests import symbols that do not exist yet — they will fail with
 * ``SyntaxError`` / ``Cannot find module`` / ``is not a function`` until the
 * implementation-specialist adds the schemas to ``@/api/schemas``.
 */
import { careResourceSchema, careResponseSchema, resonanceResponseSchema } from '../schemas';

/** Return a shallow copy of ``obj`` without ``key`` (avoids unused rest-sibling bindings). */
function omitKey<T extends Record<string, unknown>>(obj: T, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const HOTLINE_RESOURCE = {
  kind: 'hotline' as const,
  name: '988 Suicide & Crisis Lifeline',
  contact: '988',
  what_it_is: 'Free, confidential crisis support — call or text anytime.',
};

const TEXT_LINE_RESOURCE = {
  kind: 'text_line' as const,
  name: 'Crisis Text Line',
  contact: 'Text HOME to 741741',
  what_it_is: 'Text-based crisis counselling, 24/7.',
};

const HUMAN_RESOURCE = {
  kind: 'human' as const,
  name: 'Trusted person in your life',
  contact: 'Call, text, or visit',
  what_it_is: 'Someone who knows you — no professional training required.',
};

const PROFESSIONAL_RESOURCE = {
  kind: 'professional' as const,
  name: 'Licensed therapist',
  contact: 'Psychology Today directory',
  what_it_is: 'An ongoing therapeutic relationship with a credentialed clinician.',
};

const FULL_CARE_RESPONSE = {
  message: 'What you shared sounds heavy. Here are some people who can help right now.',
  resources: [HOTLINE_RESOURCE, TEXT_LINE_RESOURCE, HUMAN_RESOURCE, PROFESSIONAL_RESOURCE],
};

const BASE_RESONANCE_PAYLOAD = {
  marginalia: [],
  suggestions: [],
  remaining_messages: 48,
  remaining_balance: 0,
  monthly_reset_date: '2026-07-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// careResourceSchema
// ---------------------------------------------------------------------------

describe('careResourceSchema — valid kinds', () => {
  it('accepts kind "hotline" with all required fields', () => {
    expect(() => careResourceSchema.parse(HOTLINE_RESOURCE)).not.toThrow();
  });

  it('accepts kind "text_line" with all required fields', () => {
    expect(() => careResourceSchema.parse(TEXT_LINE_RESOURCE)).not.toThrow();
  });

  it('accepts kind "human" with all required fields', () => {
    expect(() => careResourceSchema.parse(HUMAN_RESOURCE)).not.toThrow();
  });

  it('accepts kind "professional" with all required fields', () => {
    expect(() => careResourceSchema.parse(PROFESSIONAL_RESOURCE)).not.toThrow();
  });
});

describe('careResourceSchema — field contract', () => {
  it('round-trips every scalar field exactly', () => {
    const parsed = careResourceSchema.parse(HOTLINE_RESOURCE);
    expect(parsed.kind).toBe('hotline');
    expect(parsed.name).toBe('988 Suicide & Crisis Lifeline');
    expect(parsed.contact).toBe('988');
    expect(parsed.what_it_is).toBe('Free, confidential crisis support — call or text anytime.');
  });

  it('rejects an unknown kind value', () => {
    expect(() => careResourceSchema.parse({ ...HOTLINE_RESOURCE, kind: 'chatbot' })).toThrow();
  });

  it('rejects a missing kind field', () => {
    expect(() => careResourceSchema.parse(omitKey(HOTLINE_RESOURCE, 'kind'))).toThrow();
  });

  it('rejects a missing name field', () => {
    expect(() => careResourceSchema.parse(omitKey(HOTLINE_RESOURCE, 'name'))).toThrow();
  });

  it('rejects a missing contact field', () => {
    expect(() => careResourceSchema.parse(omitKey(HOTLINE_RESOURCE, 'contact'))).toThrow();
  });

  it('rejects a missing what_it_is field', () => {
    expect(() => careResourceSchema.parse(omitKey(HOTLINE_RESOURCE, 'what_it_is'))).toThrow();
  });

  it('rejects a numeric kind (type drift)', () => {
    expect(() => careResourceSchema.parse({ ...HOTLINE_RESOURCE, kind: 42 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// careResponseSchema
// ---------------------------------------------------------------------------

describe('careResponseSchema', () => {
  it('accepts a full payload with all four resource kinds', () => {
    expect(() => careResponseSchema.parse(FULL_CARE_RESPONSE)).not.toThrow();
  });

  it('round-trips the message string', () => {
    const parsed = careResponseSchema.parse(FULL_CARE_RESPONSE);
    expect(parsed.message).toBe(FULL_CARE_RESPONSE.message);
  });

  it('round-trips all four resources in order', () => {
    const parsed = careResponseSchema.parse(FULL_CARE_RESPONSE);
    expect(parsed.resources).toHaveLength(4);
    expect(parsed.resources[0]!.kind).toBe('hotline');
    expect(parsed.resources[1]!.kind).toBe('text_line');
    expect(parsed.resources[2]!.kind).toBe('human');
    expect(parsed.resources[3]!.kind).toBe('professional');
  });

  it('accepts an empty resources array (degenerate backend response)', () => {
    expect(() => careResponseSchema.parse({ message: 'Reach out.', resources: [] })).not.toThrow();
  });

  it('rejects when resources contains an invalid kind', () => {
    expect(() =>
      careResponseSchema.parse({
        ...FULL_CARE_RESPONSE,
        resources: [{ ...HOTLINE_RESOURCE, kind: 'emergency_dispatch' }],
      }),
    ).toThrow();
  });

  it('rejects a missing message field', () => {
    expect(() => careResponseSchema.parse(omitKey(FULL_CARE_RESPONSE, 'message'))).toThrow();
  });

  it('rejects a missing resources field', () => {
    expect(() => careResponseSchema.parse({ message: 'Reach out.' })).toThrow();
  });

  it('rejects a non-array resources field (type drift)', () => {
    expect(() => careResponseSchema.parse({ message: 'Reach out.', resources: null })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resonanceResponseSchema — care field integration
// ---------------------------------------------------------------------------

describe('resonanceResponseSchema — care field', () => {
  it('validates a response WITH a care payload and preserves every field', () => {
    const payload = { ...BASE_RESONANCE_PAYLOAD, care: FULL_CARE_RESPONSE };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.care).not.toBeNull();
    expect(parsed.care!.message).toBe(FULL_CARE_RESPONSE.message);
    expect(parsed.care!.resources).toHaveLength(4);
  });

  it('validates a response WITHOUT the care field (ordinary resonance entry)', () => {
    // Backend defaults to None → the field is absent on the wire.
    const parsed = resonanceResponseSchema.parse(BASE_RESONANCE_PAYLOAD);
    expect(parsed.care == null).toBe(true);
  });

  it('validates a response where care is explicitly null', () => {
    const payload = { ...BASE_RESONANCE_PAYLOAD, care: null };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.care).toBeNull();
  });

  it('still round-trips marginalia and suggestions alongside care', () => {
    const marginaliaItem = {
      id: 1,
      journal_entry_id: 7,
      kind: 'theme',
      anchor_start: 0,
      anchor_end: 4,
      anchor_text: 'walk',
      note: 'A beginning.',
      essay: null,
      essay_generated_at: null,
      status: 'active',
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
    };
    const payload = {
      ...BASE_RESONANCE_PAYLOAD,
      marginalia: [marginaliaItem],
      care: FULL_CARE_RESPONSE,
    };
    const parsed = resonanceResponseSchema.parse(payload);
    expect(parsed.marginalia).toHaveLength(1);
    expect(parsed.marginalia[0]!.kind).toBe('theme');
    expect(parsed.care!.resources[0]!.kind).toBe('hotline');
  });

  it('rejects a care object with an invalid kind inside resources', () => {
    const badCare = {
      message: 'Reach out.',
      resources: [{ ...HOTLINE_RESOURCE, kind: 'robot' }],
    };
    expect(() =>
      resonanceResponseSchema.parse({ ...BASE_RESONANCE_PAYLOAD, care: badCare }),
    ).toThrow();
  });

  it('rejects a care object missing the message field', () => {
    const badCare = { resources: [HOTLINE_RESOURCE] };
    expect(() =>
      resonanceResponseSchema.parse({ ...BASE_RESONANCE_PAYLOAD, care: badCare }),
    ).toThrow();
  });
});
