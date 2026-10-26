import { it, expect } from '@jest/globals';

import { readingInvitationSchema } from '@/api/schemas';

it('accepts a valid Python-length source quote containing astral Unicode', () => {
  const value = {
    content_id: 1,
    stage_number: 1,
    title: 'A reading',
    entry_id: 1,
    entry_title: null,
    quote: '🌿'.repeat(150),
    reason: 'A connection',
    benefit: 'An exercise',
  };
  expect(readingInvitationSchema.safeParse(value).success).toBe(true);
  expect(readingInvitationSchema.safeParse({ ...value, quote: '🌿'.repeat(281) }).success).toBe(
    false,
  );
});
