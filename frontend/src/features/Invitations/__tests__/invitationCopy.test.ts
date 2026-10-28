/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { invitationCopy, INVITATION_COPY_ENTRIES } from '../invitationCopy';

import { invitationTargetTypeSchema, invitationKindSchema } from '@/api';

/**
 * Drift guard: ``invitationCopy`` must derive its target/kind enums from the
 * API schema, never from a hand-rolled parallel copy. These assertions fail the
 * moment a schema member gains no copy or the enumeration stops matching the
 * schema's cartesian product — the runtime backstop to the compile-time check.
 */
describe('invitationCopy drift guard', () => {
  const targets = invitationTargetTypeSchema.options;
  const kinds = invitationKindSchema.options;

  it('enumerates exactly the schema target × kind cartesian product', () => {
    expect(INVITATION_COPY_ENTRIES).toHaveLength(targets.length * kinds.length);

    const seen = new Set(INVITATION_COPY_ENTRIES.map((e) => `${e.targetType}:${e.kind}`));
    const expected = new Set(targets.flatMap((t) => kinds.map((k) => `${t}:${k}`)));
    expect(seen).toEqual(expected);
  });

  it('names every schema member — no line contains a literal "undefined"', () => {
    for (const targetType of targets) {
      for (const kind of kinds) {
        const { line } = invitationCopy(targetType, kind);
        expect(line).not.toContain('undefined');
      }
    }
  });

  it('every enumerated entry carries a non-empty rendered line', () => {
    for (const entry of INVITATION_COPY_ENTRIES) {
      expect(entry.line.length).toBeGreaterThan(0);
      expect(entry.line).not.toContain('undefined');
    }
  });

  it('states the real generator fact for every one of the 15 combinations', () => {
    for (const entry of INVITATION_COPY_ENTRIES) {
      if (entry.kind === 'consistency') {
        expect(entry.line).toContain('three weeks');
      } else if (entry.kind === 'mastery') {
        expect(entry.line).toContain('four weeks');
      } else if (entry.targetType === 'course') {
        expect(entry.line).toContain('theme in your writing');
      } else {
        expect(entry.line).toContain('most days this month');
      }
    }
  });

  it('uses a served course Aspect when present and a generic reading when absent', () => {
    expect(invitationCopy('course', 'readiness', { aspect: 'Self-Love' }).line).toContain(
      'Self-Love',
    );
    expect(invitationCopy('course', 'readiness', { aspect: '  ' }).line).toBe(
      invitationCopy('course', 'readiness').line,
    );
  });

  it.each(invitationKindSchema.options)(
    'keeps the course/%s reason truthful while naming its served Aspect',
    (kind) => {
      const named = invitationCopy('course', kind, { aspect: 'Self-Love' }).line;
      const generic = invitationCopy('course', kind).line;

      expect(named).toContain('Self-Love');
      expect(generic).toContain('course reading');
      if (kind === 'readiness') {
        expect(named).toContain('writing has circled Self-Love');
        expect(named).toContain('A related reading is available.');
      } else {
        expect(named).toContain('Self-Love reading is open to you');
        expect(named).not.toContain('built for exactly that');
      }
    },
  );

  it('offers a related reading without presuming the writer wants it', () => {
    expect(invitationCopy('course', 'readiness', { aspect: 'Embodied Understanding' }).line).toBe(
      'Your writing has circled Embodied Understanding. A related reading is available.',
    );
    expect(invitationCopy('course', 'readiness').line).toBe(
      'A theme in your writing has grown full enough to stand out. A related course reading is available.',
    );
  });
});

/**
 * Voice guard: each opener has to meet its noun as one plain sentence. The
 * mastery opener once ended in an article of its own ("there’s a deeper"), so
 * the composed line read "there’s a deeper a practice here" on the Journal
 * home — machine-assembled English, not a friend holding a door open.
 */
describe('invitationCopy reads as a sentence', () => {
  it('names the offered thing and closes with a confident offer', () => {
    expect(invitationCopy('practice', 'mastery').line).toBe(
      'You have kept a practice cadence for four weeks. A deeper practice is open to explore.',
    );
  });

  it('never stacks two articles across the opener/noun seam', () => {
    for (const entry of INVITATION_COPY_ENTRIES) {
      expect(entry.line).not.toMatch(/\b(a|an|the) (a|an|the)\b/);
    }
  });
});
