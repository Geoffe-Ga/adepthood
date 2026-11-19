/**
 * The Progress screen names a Return arc's five weeks (#3746) without reading
 * ``GET /metta-return``, so it mirrors the titles the backend's
 * ``RETURN_SEQUENCE`` owns. A mirror is honest only while it fails on drift.
 */
import { describe, expect, it } from '@jest/globals';

import { RETURN_COPY_ENTRIES, RETURN_WEEK_TITLES } from '../returnCopy';

import { readBackendSource } from '@/testing/backendSource';

/** Every `title="..."` in the sequence, in the order the backend declares it. */
function backendTitles(): string[] {
  const source = readBackendSource('src', 'domain', 'metta_return.py');
  const sequence = source.slice(source.indexOf('RETURN_SEQUENCE'));
  return [...sequence.matchAll(/title="([^"]+)"/g)].map((match) => match[1]!);
}

describe('Return week titles', () => {
  it('mirror the backend’s RETURN_SEQUENCE, week for week', () => {
    expect(backendTitles()).toHaveLength(RETURN_WEEK_TITLES.length);
    expect([...RETURN_WEEK_TITLES]).toEqual(backendTitles());
  });

  it('are swept with the rest of the Return’s copy', () => {
    for (const title of RETURN_WEEK_TITLES) expect(RETURN_COPY_ENTRIES).toContain(title);
  });
});
