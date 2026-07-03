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
});
