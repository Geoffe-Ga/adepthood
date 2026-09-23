/* eslint-env jest */
/* global describe, it, expect */
import type { FeedbackContext } from '@/api';
import {
  FEEDBACK_ANSWER_MAX_LENGTH,
  FEEDBACK_SUMMARY_MAX_LENGTH,
} from '@/features/Feedback/feedbackBounds';
import {
  FEEDBACK_CATEGORY_CONFIG,
  FEEDBACK_CATEGORY_ORDER,
} from '@/features/Feedback/feedbackCategories';
import {
  buildFeedbackCreate,
  EMPTY_FEEDBACK_ANSWERS,
  type FeedbackDraftContent,
  validateFeedbackDraft,
} from '@/features/Feedback/feedbackPayload';

const CONTEXT: FeedbackContext = {
  screen: 'journal.shelf',
  platform: 'web',
  app_build: '1.0.0',
  viewport_class: 'expanded',
};

function draft(patch: Partial<FeedbackDraftContent>): FeedbackDraftContent {
  return { category: null, impact: null, answers: { ...EMPTY_FEEDBACK_ANSWERS }, ...patch };
}

const COMPLETE_BROKEN = draft({
  category: 'broken',
  impact: 'blocked',
  answers: {
    summary: 'The save button did nothing',
    intent: 'Save my page',
    expected: 'It saves',
    actual: 'Nothing happened',
  },
});

const COMPLETE_CONFUSING = draft({
  category: 'confusing',
  impact: 'can_continue',
  answers: {
    summary: 'The ring toggle',
    intent: 'What rings do',
    actual: 'The word depth',
    expected: '',
  },
});

const COMPLETE_IDEA = draft({
  category: 'idea',
  answers: { summary: 'Dark mode', intent: 'Write at night', expected: '', actual: '' },
});

const COMPLETE_PRAISE = draft({
  category: 'praise',
  answers: { summary: 'The Map', intent: '', expected: '', actual: 'The calm colours' },
});

describe('category labels', () => {
  it('offers exactly the four choices, in order', () => {
    expect(FEEDBACK_CATEGORY_ORDER.map((c) => FEEDBACK_CATEGORY_CONFIG[c].label)).toEqual([
      'Something broke',
      'Something was confusing',
      'I have an idea',
      'Something worked well',
    ]);
    expect([...FEEDBACK_CATEGORY_ORDER]).toEqual(['broken', 'confusing', 'idea', 'praise']);
  });
});

describe('validateFeedbackDraft: no category', () => {
  it('asks for a category first', () => {
    const result = validateFeedbackDraft(draft({}));
    expect(result.ok).toBe(false);
    expect(result.errors.category).toBeDefined();
  });
});

describe('validateFeedbackDraft: broken', () => {
  it('accepts a complete report', () => {
    expect(validateFeedbackDraft(COMPLETE_BROKEN)).toEqual({ ok: true, errors: {} });
  });

  it.each([['summary'], ['intent'], ['expected'], ['actual']] as const)('requires %s', (field) => {
    const result = validateFeedbackDraft({
      ...COMPLETE_BROKEN,
      answers: { ...COMPLETE_BROKEN.answers, [field]: '   ' },
    });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors)).toEqual([field]);
  });

  it('requires an impact', () => {
    const result = validateFeedbackDraft({ ...COMPLETE_BROKEN, impact: null });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors)).toEqual(['impact']);
  });

  it('rejects not_applicable, which is not one of its choices', () => {
    const result = validateFeedbackDraft({ ...COMPLETE_BROKEN, impact: 'not_applicable' });
    expect(result.errors.impact).toBeDefined();
  });

  it.each([['blocked'], ['can_continue'], ['cosmetic']] as const)('accepts impact %s', (impact) => {
    expect(validateFeedbackDraft({ ...COMPLETE_BROKEN, impact }).ok).toBe(true);
  });
});

describe('validateFeedbackDraft: confusing', () => {
  it('accepts a complete report with the optional answer blank', () => {
    expect(validateFeedbackDraft(COMPLETE_CONFUSING).ok).toBe(true);
  });

  it.each([['summary'], ['intent'], ['actual']] as const)('requires %s', (field) => {
    const result = validateFeedbackDraft({
      ...COMPLETE_CONFUSING,
      answers: { ...COMPLETE_CONFUSING.answers, [field]: '' },
    });
    expect(Object.keys(result.errors)).toEqual([field]);
  });

  it('asks what they were trying to understand (intent) and what misled them (actual)', () => {
    const questions = FEEDBACK_CATEGORY_CONFIG.confusing.questions;
    expect(questions.find((q) => q.field === 'intent')?.label).toMatch(/trying to understand/);
    expect(questions.find((q) => q.field === 'actual')?.label).toMatch(/misled/);
  });

  it('requires an impact', () => {
    expect(
      Object.keys(validateFeedbackDraft({ ...COMPLETE_CONFUSING, impact: null }).errors),
    ).toEqual(['impact']);
  });
});

describe('validateFeedbackDraft: idea', () => {
  it('accepts a complete report with no impact chosen', () => {
    expect(validateFeedbackDraft(COMPLETE_IDEA).ok).toBe(true);
  });

  it.each([['summary'], ['intent']] as const)('requires %s', (field) => {
    const result = validateFeedbackDraft({
      ...COMPLETE_IDEA,
      answers: { ...COMPLETE_IDEA.answers, [field]: '' },
    });
    expect(Object.keys(result.errors)).toEqual([field]);
  });

  it('asks for the desired outcome as intent', () => {
    const intent = FEEDBACK_CATEGORY_CONFIG.idea.questions.find((q) => q.field === 'intent');
    expect(intent?.required).toBe(true);
    expect(intent?.label).toMatch(/like to be able to do/);
  });
});

describe('validateFeedbackDraft: praise', () => {
  it('accepts a complete report', () => {
    expect(validateFeedbackDraft(COMPLETE_PRAISE).ok).toBe(true);
  });

  it.each([['summary'], ['actual']] as const)('requires %s', (field) => {
    const result = validateFeedbackDraft({
      ...COMPLETE_PRAISE,
      answers: { ...COMPLETE_PRAISE.answers, [field]: '' },
    });
    expect(Object.keys(result.errors)).toEqual([field]);
  });

  it('asks what should be preserved', () => {
    const labels = FEEDBACK_CATEGORY_CONFIG.praise.questions.map((q) => q.label).join(' ');
    expect(labels).toMatch(/keep/);
  });
});

describe('validateFeedbackDraft: bounds', () => {
  it('rejects a whitespace-only summary', () => {
    const result = validateFeedbackDraft({
      ...COMPLETE_IDEA,
      answers: { ...COMPLETE_IDEA.answers, summary: ' \n\t ' },
    });
    expect(result.errors.summary).toBeDefined();
  });

  it('accepts a summary of exactly 280 characters and rejects 281', () => {
    const at = 'a'.repeat(FEEDBACK_SUMMARY_MAX_LENGTH);
    const withSummary = (summary: string) =>
      validateFeedbackDraft({ ...COMPLETE_IDEA, answers: { ...COMPLETE_IDEA.answers, summary } });
    expect(withSummary(at).ok).toBe(true);
    expect(withSummary(`${at}a`).errors.summary).toMatch(/280/);
    // Counted after trimming: padding does not push a legal summary over.
    expect(withSummary(`  ${at}  `).ok).toBe(true);
  });

  it('accepts an answer of exactly 2000 characters and rejects 2001', () => {
    const at = 'b'.repeat(FEEDBACK_ANSWER_MAX_LENGTH);
    const withIntent = (intent: string) =>
      validateFeedbackDraft({ ...COMPLETE_IDEA, answers: { ...COMPLETE_IDEA.answers, intent } });
    expect(withIntent(at).ok).toBe(true);
    expect(withIntent(`${at}b`).errors.intent).toMatch(/2000/);
  });

  it('bounds an optional answer too', () => {
    const over = 'c'.repeat(FEEDBACK_ANSWER_MAX_LENGTH + 1);
    const result = validateFeedbackDraft({
      ...COMPLETE_IDEA,
      answers: { ...COMPLETE_IDEA.answers, expected: over },
    });
    expect(Object.keys(result.errors)).toEqual(['expected']);
  });
});

describe('buildFeedbackCreate', () => {
  it('returns null until a category is chosen', () => {
    expect(buildFeedbackCreate(draft({}), CONTEXT)).toBeNull();
  });

  it('returns null for a cost category with no impact yet', () => {
    expect(buildFeedbackCreate({ ...COMPLETE_BROKEN, impact: null }, CONTEXT)).toBeNull();
  });

  it('sends trimmed answers and carries the context object by reference', () => {
    const payload = buildFeedbackCreate(
      { ...COMPLETE_BROKEN, answers: { ...COMPLETE_BROKEN.answers, summary: '  padded  ' } },
      CONTEXT,
    );
    expect(payload).toEqual({
      category: 'broken',
      impact: 'blocked',
      summary: 'padded',
      intent: 'Save my page',
      expected: 'It saves',
      actual: 'Nothing happened',
      context: CONTEXT,
    });
    expect(payload?.context).toBe(CONTEXT);
  });

  it('omits empty optional answers', () => {
    const payload = buildFeedbackCreate(COMPLETE_CONFUSING, CONTEXT);
    expect(payload).not.toHaveProperty('expected');
    expect(payload?.actual).toBe('The word depth');
  });

  it('never sends an answer the category does not ask for', () => {
    const payload = buildFeedbackCreate(
      {
        ...COMPLETE_PRAISE,
        answers: { ...COMPLETE_PRAISE.answers, intent: 'left over from broken' },
      },
      CONTEXT,
    );
    expect(payload).not.toHaveProperty('intent');
  });

  it.each([
    ['idea', COMPLETE_IDEA],
    ['praise', COMPLETE_PRAISE],
  ])('forces not_applicable for %s, whatever impact the draft carries', (_name, content) => {
    expect(buildFeedbackCreate({ ...content, impact: 'blocked' }, CONTEXT)?.impact).toBe(
      'not_applicable',
    );
    expect(buildFeedbackCreate({ ...content, impact: null }, CONTEXT)?.impact).toBe(
      'not_applicable',
    );
  });
});
