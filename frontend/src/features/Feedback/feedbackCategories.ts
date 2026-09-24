/**
 * What the composer asks, per kind of report (#2898).
 *
 * The intake contract has one required prose field (`summary`) and three
 * optional ones (`intent`, `expected`, `actual`). Which of those a report
 * needs depends on what kind of report it is, and the server cannot know that,
 * so the per-category requirements live here and are enforced before the
 * network call. Where a category's question has no field of its own name --
 * "what misled you", "what should we keep" -- it is mapped onto the nearest of
 * the three, and that mapping is this table, not something a screen decides.
 */
import type { FeedbackCategory, FeedbackImpact } from '@/api';

/** The four prose fields a report can carry. */
export type FeedbackAnswerField = 'summary' | 'intent' | 'expected' | 'actual';

export interface FeedbackQuestion {
  field: FeedbackAnswerField;
  label: string;
  hint: string;
  required: boolean;
  /** Short one-line answer (summary) versus a few sentences. */
  multiline: boolean;
}

export interface FeedbackCategoryConfig {
  category: FeedbackCategory;
  /** The choice as the first step shows it. */
  label: string;
  /** One line under the choice, and its accessibility hint. */
  description: string;
  questions: readonly FeedbackQuestion[];
  /** The impacts a person picks from; empty when the category fixes one. */
  impactChoices: readonly FeedbackImpact[];
  /** Sent without asking, for categories where "impact" is not a question. */
  fixedImpact?: FeedbackImpact;
}

/** The order the first step offers the four choices in. */
export const FEEDBACK_CATEGORY_ORDER = ['broken', 'confusing', 'idea', 'praise'] as const;

/** The impacts that describe a cost; `not_applicable` is only ever fixed. */
const COST_IMPACTS: readonly FeedbackImpact[] = ['blocked', 'can_continue', 'cosmetic'];

export const FEEDBACK_IMPACT_LABELS: Readonly<Record<FeedbackImpact, string>> = {
  blocked: 'It stopped me',
  can_continue: 'I could carry on',
  cosmetic: 'It only looks wrong',
  not_applicable: 'Not applicable',
};

export const FEEDBACK_CATEGORY_CONFIG: Readonly<Record<FeedbackCategory, FeedbackCategoryConfig>> =
  {
    broken: {
      category: 'broken',
      label: 'Something broke',
      description: 'Something did not work the way it should.',
      questions: [
        {
          field: 'summary',
          label: 'In one sentence, what broke?',
          hint: 'A short line we can recognise the problem by.',
          required: true,
          multiline: false,
        },
        {
          field: 'intent',
          label: 'What were you trying to do?',
          hint: 'The thing you set out to do when it happened.',
          required: true,
          multiline: true,
        },
        {
          field: 'expected',
          label: 'What did you expect to happen?',
          hint: 'What you thought the app would do.',
          required: true,
          multiline: true,
        },
        {
          field: 'actual',
          label: 'What happened instead?',
          hint: 'What the app actually did.',
          required: true,
          multiline: true,
        },
      ],
      impactChoices: COST_IMPACTS,
    },
    confusing: {
      category: 'confusing',
      label: 'Something was confusing',
      description: 'Something was hard to understand or find.',
      questions: [
        {
          field: 'summary',
          label: 'In one sentence, what was confusing?',
          hint: 'A short line we can recognise it by.',
          required: true,
          multiline: false,
        },
        {
          field: 'intent',
          label: 'What were you trying to understand?',
          hint: 'The question you had in mind at the time.',
          required: true,
          multiline: true,
        },
        {
          field: 'actual',
          label: 'What misled you?',
          hint: 'The wording, label or behaviour that sent you the wrong way.',
          required: true,
          multiline: true,
        },
        {
          field: 'expected',
          label: 'What would have made it clear? (optional)',
          hint: 'Leave this blank if nothing comes to mind.',
          required: false,
          multiline: true,
        },
      ],
      impactChoices: COST_IMPACTS,
    },
    idea: {
      category: 'idea',
      label: 'I have an idea',
      description: 'Something you would like Adepthood to do.',
      questions: [
        {
          field: 'summary',
          label: 'In one sentence, what is the idea?',
          hint: 'A short line we can recognise the idea by.',
          required: true,
          multiline: false,
        },
        {
          field: 'intent',
          label: 'What would you like to be able to do?',
          hint: 'The outcome you are after, rather than how to build it.',
          required: true,
          multiline: true,
        },
        {
          field: 'expected',
          label: 'How do you picture it working? (optional)',
          hint: 'Leave this blank if you would rather not guess.',
          required: false,
          multiline: true,
        },
      ],
      impactChoices: [],
      fixedImpact: 'not_applicable',
    },
    praise: {
      category: 'praise',
      label: 'Something worked well',
      description: 'Something you would like us to keep.',
      questions: [
        {
          field: 'summary',
          label: 'In one sentence, what worked well?',
          hint: 'A short line we can recognise it by.',
          required: true,
          multiline: false,
        },
        {
          field: 'actual',
          label: 'What should we be careful to keep?',
          hint: 'The part that mattered, so a later change does not lose it.',
          required: true,
          multiline: true,
        },
      ],
      impactChoices: [],
      fixedImpact: 'not_applicable',
    },
  };
