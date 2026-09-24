/**
 * The composer's words, in one place so the privacy-policy drift guard and the
 * screen tests read the same strings the screen renders.
 *
 * The "What will be attached" copy has to agree with the Beta feedback section
 * of `docs/legal/privacy-policy.md`, which `feedbackPrivacyPolicyDrift.test.ts`
 * checks: the same seven fields, the same exclusions, the same retention.
 */
import type { FeedbackContext } from '@/api';

export const FEEDBACK_COMPOSER_COPY = {
  title: 'Send feedback',
  lead: 'Tell us what happened. Reports go to the people who build Adepthood.',
  categoryPrompt: 'What kind of feedback is this?',
  impactPrompt: 'How much did this affect you?',
  send: 'Send report',
  sendAgain: 'Send again',
  editReport: 'Edit report',
  done: 'Done',
  loading: 'Opening your draft…',
  needsAttention: 'Some answers need attention before this can be sent.',
} as const;

export const FEEDBACK_PREVIEW_COPY = {
  heading: 'What will be attached',
  lead: 'Along with your answers, this report carries only these details:',
  notIncluded:
    'Not included: any other writing of yours, your journal content, passwords, private vault addresses, or the contents of the screen.',
  retention: 'Reports are kept for 180 days.',
} as const;

/** A readable label for each of the seven envelope keys. */
export const FEEDBACK_CONTEXT_LABELS: Readonly<Record<keyof FeedbackContext, string>> = {
  screen: 'Screen',
  control: 'Control',
  platform: 'Platform',
  app_build: 'App build',
  viewport_class: 'Viewport class',
  locale: 'Locale',
  correlation_id: 'Correlation id',
};

/** The entry points' visible labels and accessible name. */
export const SEND_FEEDBACK_LABEL = 'Send feedback';
export const SEND_FEEDBACK_COMPACT_LABEL = 'Feedback';
export const SEND_FEEDBACK_HINT = 'Opens a short form to report a problem, a confusion or an idea.';
export const SETTINGS_FEEDBACK_DESCRIPTION =
  'Report something that broke or confused you, share an idea, or tell us what worked.';
