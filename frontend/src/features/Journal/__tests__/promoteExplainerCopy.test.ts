/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import { PROMOTED_QUOTES_LABEL } from '../JournalDrawer';
import {
  PROMOTED_NOTICE_COPY,
  PROMOTE_EXPLAINER_BODY,
  PROMOTE_EXPLAINER_CANCEL,
  PROMOTE_EXPLAINER_CONTINUE,
  PROMOTE_EXPLAINER_COPY_ENTRIES,
  PROMOTE_EXPLAINER_DONT_SHOW,
  PROMOTE_EXPLAINER_TITLE,
} from '../promoteExplainerCopy';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

describe('promoteExplainerCopy — says what promotion is and where the quote goes', () => {
  it('names the affordance and the two arms in the issue’s words', () => {
    expect(PROMOTE_EXPLAINER_TITLE).toBe('Promote a quote');
    expect(PROMOTE_EXPLAINER_CONTINUE).toBe('Choose the passage');
    expect(PROMOTE_EXPLAINER_CANCEL).toBe('Not now');
    expect(PROMOTE_EXPLAINER_DONT_SHOW).toBe('Don’t show this again');
  });

  it('names only what the sources feed does: a review covering the week, and the drawer door', () => {
    // GET /reflections/sources attaches a pending quote to its source entry, so
    // it surfaces in a review whose window covers the day that entry was
    // written -- not in whichever review comes next.
    expect(PROMOTE_EXPLAINER_BODY).toContain('a review that covers the week you wrote it');
    expect(PROMOTE_EXPLAINER_BODY).not.toMatch(/next review/);
    // The door is named exactly as the drawer labels it, so the reader can find it.
    expect(PROMOTE_EXPLAINER_BODY).toContain(`${PROMOTED_QUOTES_LABEL} in the Journal menu`);
  });

  it('the Promoted notice names where the quote went, and only a place that always lists it', () => {
    expect(PROMOTED_NOTICE_COPY).toBe(`Promoted — find it any time under ${PROMOTED_QUOTES_LABEL}`);
  });
});

describe('promoteExplainerCopy — balance-not-altitude intent rule', () => {
  it('sweeps every line the reader sees', () => {
    expect(PROMOTE_EXPLAINER_COPY_ENTRIES).toContain(PROMOTE_EXPLAINER_BODY);
    expect(PROMOTE_EXPLAINER_COPY_ENTRIES).toContain(PROMOTED_NOTICE_COPY);
  });

  it('no entry ranks or shames the person', () => {
    for (const entry of PROMOTE_EXPLAINER_COPY_ENTRIES) {
      expect(ranksOrShames(entry)).toBe(false);
    }
  });

  it('no entry leans on forever, keep-going, or must pressure language', () => {
    for (const entry of PROMOTE_EXPLAINER_COPY_ENTRIES) {
      expect(entry).not.toMatch(/\bforever\b/i);
      expect(entry).not.toMatch(/keep going/i);
      expect(entry).not.toMatch(/\bmust\b/i);
    }
  });
});
