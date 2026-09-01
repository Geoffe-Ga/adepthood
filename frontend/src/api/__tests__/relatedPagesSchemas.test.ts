/* eslint-env jest */
/* global describe, it, expect */

/**
 * Tests for the two related-page collections on ``resonanceResponseSchema``.
 *
 * The backend surfaces the writer's own compiled vault pages beside a
 * reflection its vault answered: ``related_praxis`` and ``related_eddies``,
 * both always present and both empty on every pass no vault answered. The
 * client's stake in them is narrower than rendering (that is a separate issue)
 * and is exactly what these cover: the fields survive the boundary rather than
 * being silently stripped, the two closed vocabularies are narrowed so a
 * drifted value fails here instead of rendering an unlabelled page, and a
 * response predating the fields still parses.
 */
import { resonanceResponseSchema } from '../schemas';

/** Minimal valid resonance response carrying neither related collection. */
const BASE_RESONANCE = {
  marginalia: [],
  suggestions: [],
  remaining_messages: 48,
  remaining_balance: 0,
  monthly_reset_date: '2026-07-01T00:00:00Z',
};

const PRAXIS = {
  title: 'Rest before the collapse',
  praxis_type: 'practice',
  status: 'active',
  excerpt: "The page's own opening lines, as the writer wrote them.",
};

const EDDY = {
  title: 'Rest and Ruin',
  description: 'A cluster the writer keeps returning to.',
  fragment_count: 12,
  formed: '2026-03-04',
};

describe('resonanceResponseSchema — related pages (backward-compat)', () => {
  it('still parses a response carrying neither collection', () => {
    const parsed = resonanceResponseSchema.parse(BASE_RESONANCE);

    expect(parsed.related_praxis).toBeUndefined();
    expect(parsed.related_eddies).toBeUndefined();
  });

  it('parses the empty collections a cloud-answered pass sends', () => {
    const parsed = resonanceResponseSchema.parse({
      ...BASE_RESONANCE,
      related_praxis: [],
      related_eddies: [],
    });

    expect(parsed.related_praxis).toEqual([]);
    expect(parsed.related_eddies).toEqual([]);
  });
});

describe('resonanceResponseSchema — related pages (round-trip)', () => {
  it('carries every field of both page kinds across the boundary', () => {
    const parsed = resonanceResponseSchema.parse({
      ...BASE_RESONANCE,
      related_praxis: [PRAXIS],
      related_eddies: [EDDY],
    });

    expect(parsed.related_praxis).toEqual([PRAXIS]);
    expect(parsed.related_eddies).toEqual([EDDY]);
  });

  it('rejects a praxis kind outside the published vocabulary', () => {
    const payload = {
      ...BASE_RESONANCE,
      related_praxis: [{ ...PRAXIS, praxis_type: 'ritual' }],
    };

    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a praxis lifecycle outside the published vocabulary', () => {
    const payload = {
      ...BASE_RESONANCE,
      related_praxis: [{ ...PRAXIS, status: 'archived' }],
    };

    expect(() => resonanceResponseSchema.parse(payload)).toThrow();
  });

  it('accepts an eddy that declares no description of its own', () => {
    const undescribed = { ...EDDY, description: '' };

    const parsed = resonanceResponseSchema.parse({
      ...BASE_RESONANCE,
      related_eddies: [undescribed],
    });

    expect(parsed.related_eddies).toEqual([undescribed]);
  });
});
