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
  PROMOTE_EXPLAINER_READING_BODY,
  PROMOTE_EXPLAINER_TITLE,
  promoteExplainerWords,
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

/**
 * A chapter or a letter has no week of its own (#3660): a reading quote is
 * offered to the review whose window covers the day it was promoted, so the
 * variant says that (owner decision), and the entry wording stays as it was.
 */
describe('promoteExplainerCopy — the reading variant', () => {
  it('says a reading quote waits for the review covering the week it is promoted', () => {
    expect(PROMOTE_EXPLAINER_READING_BODY).toContain('the review covering the week you promote it');
    expect(PROMOTE_EXPLAINER_READING_BODY).not.toMatch(/you wrote it/);
    expect(PROMOTE_EXPLAINER_READING_BODY).toContain(
      `${PROMOTED_QUOTES_LABEL} in the Journal menu`,
    );
  });

  it('keeps the entry wording for an entry, and words a chapter and a letter alike', () => {
    expect(promoteExplainerWords('entry').body).toBe(PROMOTE_EXPLAINER_BODY);
    expect(promoteExplainerWords('course').body).toBe(PROMOTE_EXPLAINER_READING_BODY);
    expect(promoteExplainerWords('letter').body).toBe(PROMOTE_EXPLAINER_READING_BODY);
  });

  it('goes on to choosing a passage, or -- once one is chosen -- to promoting it', () => {
    expect(promoteExplainerWords('letter')).toMatchObject({
      continueLabel: PROMOTE_EXPLAINER_CONTINUE,
      continueA11y: 'Choose the passage to promote',
    });
    expect(promoteExplainerWords('course', true)).toMatchObject({
      continueLabel: 'Promote the passage',
      continueA11y: 'Promote the passage you chose',
    });
  });
});

describe('promoteExplainerCopy — balance-not-altitude intent rule', () => {
  it('sweeps every line the reader sees', () => {
    expect(PROMOTE_EXPLAINER_COPY_ENTRIES).toContain(PROMOTE_EXPLAINER_BODY);
    expect(PROMOTE_EXPLAINER_COPY_ENTRIES).toContain(PROMOTE_EXPLAINER_READING_BODY);
    expect(PROMOTE_EXPLAINER_COPY_ENTRIES).toContain(
      promoteExplainerWords('course', true).continueLabel,
    );
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
