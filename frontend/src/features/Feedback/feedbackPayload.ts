/**
 * The ONLY producer of a `FeedbackCreate`, and the validation that gates it.
 *
 * The composer renders its "What will be attached" preview from the object this
 * module returns and passes that same object to `feedback.submit`, so what the
 * tester reads is what is sent by construction rather than by two builders
 * agreeing.
 */
import {
  FEEDBACK_ANSWER_MAX_LENGTH,
  FEEDBACK_SUMMARY_MAX_LENGTH,
  FEEDBACK_SUMMARY_MIN_LENGTH,
} from './feedbackBounds';
import {
  FEEDBACK_CATEGORY_CONFIG,
  type FeedbackAnswerField,
  type FeedbackCategoryConfig,
} from './feedbackCategories';

import type { FeedbackCategory, FeedbackContext, FeedbackCreate, FeedbackImpact } from '@/api';

export type FeedbackAnswers = Record<FeedbackAnswerField, string>;

export const EMPTY_FEEDBACK_ANSWERS: Readonly<FeedbackAnswers> = {
  summary: '',
  intent: '',
  expected: '',
  actual: '',
};

/** What a person has entered so far: the part of a draft that becomes a report. */
export interface FeedbackDraftContent {
  category: FeedbackCategory | null;
  impact: FeedbackImpact | null;
  answers: FeedbackAnswers;
}

/** Every top-level field `buildFeedbackCreate` can emit; checked against the server's. */
export const FEEDBACK_CREATE_FIELDS = [
  'category',
  'impact',
  'summary',
  'intent',
  'expected',
  'actual',
  'context',
] as const satisfies ReadonlyArray<keyof FeedbackCreate>;

export type FeedbackErrorKey = FeedbackAnswerField | 'category' | 'impact';

export interface FeedbackValidation {
  ok: boolean;
  errors: Partial<Record<FeedbackErrorKey, string>>;
}

export const FEEDBACK_VALIDATION_COPY = {
  category: 'Choose what kind of report this is.',
  impact: 'Choose how much this affected you.',
  required: 'This one is needed for this kind of report.',
  summaryTooLong: `Keep the summary to ${FEEDBACK_SUMMARY_MAX_LENGTH} characters or fewer.`,
  answerTooLong: `Keep this answer to ${FEEDBACK_ANSWER_MAX_LENGTH} characters or fewer.`,
} as const;

function answerError(
  field: FeedbackAnswerField,
  value: string,
  required: boolean,
): string | undefined {
  const trimmed = value.trim();
  const isSummary = field === 'summary';
  const min = isSummary ? FEEDBACK_SUMMARY_MIN_LENGTH : 1;
  if (trimmed.length < min) return required ? FEEDBACK_VALIDATION_COPY.required : undefined;
  if (isSummary) {
    return trimmed.length > FEEDBACK_SUMMARY_MAX_LENGTH
      ? FEEDBACK_VALIDATION_COPY.summaryTooLong
      : undefined;
  }
  return trimmed.length > FEEDBACK_ANSWER_MAX_LENGTH
    ? FEEDBACK_VALIDATION_COPY.answerTooLong
    : undefined;
}

function resolveImpact(
  config: FeedbackCategoryConfig,
  chosen: FeedbackImpact | null,
): FeedbackImpact | null {
  if (config.fixedImpact !== undefined) return config.fixedImpact;
  return chosen !== null && config.impactChoices.includes(chosen) ? chosen : null;
}

/** Check a draft against its category's questions, before anything is sent. */
export function validateFeedbackDraft(draft: FeedbackDraftContent): FeedbackValidation {
  if (draft.category === null) {
    return { ok: false, errors: { category: FEEDBACK_VALIDATION_COPY.category } };
  }
  const config = FEEDBACK_CATEGORY_CONFIG[draft.category];
  const errors: FeedbackValidation['errors'] = {};
  for (const question of config.questions) {
    const error = answerError(question.field, draft.answers[question.field], question.required);
    if (error !== undefined) errors[question.field] = error;
  }
  if (resolveImpact(config, draft.impact) === null) errors.impact = FEEDBACK_VALIDATION_COPY.impact;
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Turn a draft into the request body, or `null` while it cannot be one yet.
 *
 * Only the fields the category asks for are read, answers are trimmed, and an
 * empty optional answer is omitted rather than sent blank. `context` is carried
 * by reference so the preview and the request share one object.
 */
export function buildFeedbackCreate(
  draft: FeedbackDraftContent,
  context: FeedbackContext,
): FeedbackCreate | null {
  if (draft.category === null) return null;
  const config = FEEDBACK_CATEGORY_CONFIG[draft.category];
  const impact = resolveImpact(config, draft.impact);
  if (impact === null) return null;
  const payload: FeedbackCreate = {
    category: draft.category,
    impact,
    summary: draft.answers.summary.trim(),
    context,
  };
  for (const { field } of config.questions) {
    const value = draft.answers[field].trim();
    if (field !== 'summary' && value.length > 0) payload[field] = value;
  }
  return payload;
}
