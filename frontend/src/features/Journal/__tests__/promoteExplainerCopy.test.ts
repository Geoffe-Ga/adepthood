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

  it('names both destinations: the next review of any kind, and the drawer door', () => {
    expect(PROMOTE_EXPLAINER_BODY).toContain('top of your next review');
    expect(PROMOTE_EXPLAINER_BODY).toContain('weekly, stage, section or course');
    // The door is named exactly as the drawer labels it, so the reader can find it.
    expect(PROMOTE_EXPLAINER_BODY).toContain(`${PROMOTED_QUOTES_LABEL} in the Journal menu`);
  });

  it('the Promoted notice names where the quote went', () => {
    expect(PROMOTED_NOTICE_COPY).toBe('Promoted — waiting for your next review');
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
