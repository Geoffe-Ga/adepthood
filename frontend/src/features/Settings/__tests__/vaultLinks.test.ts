import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from '@jest/globals';

import { VAULT_RUN_YOUR_OWN_DOC_ANCHOR, VAULT_RUN_YOUR_OWN_DOC_URL } from '../vaultLinks';

import { REPO_ROOT } from '@/testing/backendSource';

/**
 * The "Learn how to run one" link lands on a heading that exists.
 *
 * GitHub serves a fragment that matches no heading as the top of the page,
 * silently, and the backend's path resolver for the legal links stops at the
 * ``#``. So this computes GitHub's own slug for every heading in the document,
 * duplicates numbered the way GitHub numbers them, and requires the anchor to
 * name exactly one.
 */

const YOUR_DATA = path.join(REPO_ROOT, 'docs', 'your-data.md');
const BLOB_PREFIX = 'https://github.com/Geoffe-Ga/adepthood/blob/main/docs/your-data.md#';

/** GitHub's heading slug: lower-cased, punctuation dropped, spaces to hyphens. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

/** Every heading's anchor, numbered for repeats as GitHub numbers them. */
function headingAnchors(markdown: string): string[] {
  const seen = new Map<string, number>();
  return [...markdown.matchAll(/^#{1,6} (.+)$/gmu)].map((match) => {
    const slug = githubSlug(match[1] ?? '');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  });
}

describe('vaultLinks — the run-your-own guide', () => {
  it('is an https blob URL to docs/your-data.md, ending in the named anchor', () => {
    expect(VAULT_RUN_YOUR_OWN_DOC_URL).toBe(`${BLOB_PREFIX}${VAULT_RUN_YOUR_OWN_DOC_ANCHOR}`);
    expect(VAULT_RUN_YOUR_OWN_DOC_ANCHOR).toBe('running-your-own-vault');
  });

  it('points at no legal document', () => {
    expect(VAULT_RUN_YOUR_OWN_DOC_URL).not.toMatch(/docs\/legal/u);
  });

  it('names exactly one heading in the document', () => {
    const anchors = headingAnchors(fs.readFileSync(YOUR_DATA, 'utf-8'));

    expect(anchors.filter((anchor) => anchor === VAULT_RUN_YOUR_OWN_DOC_ANCHOR)).toHaveLength(1);
  });

  it('numbers a repeated heading, so a duplicate cannot pass for the original', () => {
    expect(headingAnchors('## Same\n\n### Same\n')).toEqual(['same', 'same-1']);
    expect(githubSlug('If you use a Creek Vault')).toBe('if-you-use-a-creek-vault');
    expect(githubSlug('Support & care')).toBe('support--care');
  });
});
