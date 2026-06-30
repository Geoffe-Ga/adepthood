/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

/**
 * RED tests for ``careResources.ts`` (issue #892 — always-available Support &
 * care in Settings).
 *
 * These tests fail until the implementation-specialist creates
 * ``frontend/src/features/Settings/careResources.ts`` that exports:
 *   - ``STANDING_CARE: CareResponse``  — the static, always-available payload
 *   - ``CARE_LIMITS_LINE: string``     — the disclaimer about professional care
 */
import { STANDING_CARE, CARE_LIMITS_LINE } from '../careResources';

import { careResponseSchema } from '@/api/schemas';

// ---------------------------------------------------------------------------
// Dynamic imports — fails immediately on missing module (RED signal)
// ---------------------------------------------------------------------------

// NOTE: we import with `await import(...)` in each test so the module-not-found
// error is the RED reason (not a parse-time crash that swallows the test name).

// ---------------------------------------------------------------------------
// STANDING_CARE structural validity
// ---------------------------------------------------------------------------

describe('STANDING_CARE — Zod schema compliance', () => {
  it('parses cleanly through careResponseSchema (structural identity)', () => {
    const result = careResponseSchema.safeParse(STANDING_CARE);
    expect(result.success).toBe(true);
  });

  it('has a non-empty message string', () => {
    expect(typeof STANDING_CARE.message).toBe('string');
    expect(STANDING_CARE.message.length).toBeGreaterThan(0);
  });

  it('contains exactly four resource entries', () => {
    expect(STANDING_CARE.resources).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// STANDING_CARE — kind ordering: hotline → text_line → human → professional
// ---------------------------------------------------------------------------

describe('STANDING_CARE — resource ordering', () => {
  it('the first resource has kind "hotline"', () => {
    expect(STANDING_CARE.resources[0]?.kind).toBe('hotline');
  });

  it('the second resource has kind "text_line"', () => {
    expect(STANDING_CARE.resources[1]?.kind).toBe('text_line');
  });

  it('the third resource has kind "human"', () => {
    expect(STANDING_CARE.resources[2]?.kind).toBe('human');
  });

  it('the fourth resource has kind "professional"', () => {
    expect(STANDING_CARE.resources[3]?.kind).toBe('professional');
  });
});

// ---------------------------------------------------------------------------
// STANDING_CARE — required contacts present
// ---------------------------------------------------------------------------

describe('STANDING_CARE — required crisis contacts', () => {
  it('the hotline resource contains "988" in its contact field', () => {
    const hotline = STANDING_CARE.resources.find((r) => r.kind === 'hotline');
    expect(hotline).toBeDefined();
    expect(hotline?.contact).toContain('988');
  });

  it('the text_line resource contains "741741" in its contact field', () => {
    const textLine = STANDING_CARE.resources.find((r) => r.kind === 'text_line');
    expect(textLine).toBeDefined();
    expect(textLine?.contact).toContain('741741');
  });
});

// ---------------------------------------------------------------------------
// STANDING_CARE — each resource has non-empty name / contact / what_it_is
// ---------------------------------------------------------------------------

describe('STANDING_CARE — resource field completeness', () => {
  const KINDS = ['hotline', 'text_line', 'human', 'professional'] as const;

  for (const kind of KINDS) {
    it(`"${kind}" resource has a non-empty name`, () => {
      const resource = STANDING_CARE.resources.find((r) => r.kind === kind);
      expect(resource).toBeDefined();
      expect(resource?.name.length).toBeGreaterThan(0);
    });

    it(`"${kind}" resource has a non-empty contact`, () => {
      const resource = STANDING_CARE.resources.find((r) => r.kind === kind);
      expect(resource?.contact.length).toBeGreaterThan(0);
    });

    it(`"${kind}" resource has a non-empty what_it_is`, () => {
      const resource = STANDING_CARE.resources.find((r) => r.kind === kind);
      expect(resource?.what_it_is.length).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// CARE_LIMITS_LINE — present and contains the complementary-care idea
// ---------------------------------------------------------------------------

describe('CARE_LIMITS_LINE — content requirements', () => {
  it('is a non-empty string', () => {
    expect(typeof CARE_LIMITS_LINE).toBe('string');
    expect(CARE_LIMITS_LINE.length).toBeGreaterThan(0);
  });

  it('conveys that this complements professional care', () => {
    // Must contain the "complements" or "complement" root to convey the idea.
    // Case-insensitive because capitalisation is a style choice.
    expect(CARE_LIMITS_LINE.toLowerCase()).toMatch(/complement/);
  });

  it('conveys that this does not replace professional care', () => {
    // Must contain "replace" (or "replaces") to convey the limiting idea.
    expect(CARE_LIMITS_LINE.toLowerCase()).toMatch(/replace/);
  });
});

// ---------------------------------------------------------------------------
// Safety gate — no diagnosis/medication wording anywhere in STANDING_CARE
// ---------------------------------------------------------------------------

describe('STANDING_CARE — prohibited clinical wording', () => {
  const PROHIBITED = [/diagnos/i, /medic(at|ine)/i, /prescri/i, /disorder/i, /symptom/i];

  it('no resource name contains prohibited clinical wording', () => {
    for (const resource of STANDING_CARE.resources) {
      for (const pattern of PROHIBITED) {
        expect(resource.name).not.toMatch(pattern);
      }
    }
  });

  it('no resource contact contains prohibited clinical wording', () => {
    for (const resource of STANDING_CARE.resources) {
      for (const pattern of PROHIBITED) {
        expect(resource.contact).not.toMatch(pattern);
      }
    }
  });

  it('no resource what_it_is contains prohibited clinical wording', () => {
    for (const resource of STANDING_CARE.resources) {
      for (const pattern of PROHIBITED) {
        expect(resource.what_it_is).not.toMatch(pattern);
      }
    }
  });

  it('the message does not contain prohibited clinical wording', () => {
    for (const pattern of PROHIBITED) {
      expect(STANDING_CARE.message).not.toMatch(pattern);
    }
  });

  it('CARE_LIMITS_LINE does not contain prohibited clinical wording', () => {
    for (const pattern of PROHIBITED) {
      expect(CARE_LIMITS_LINE).not.toMatch(pattern);
    }
  });
});
