import { CONTROL_PATTERN, FEEDBACK_CONTROL_MAX_LENGTH } from './feedbackBounds';

/**
 * Every control that may open the composer, as the stable token the report's
 * `context.control` carries.
 *
 * A finite set rather than "anything matching CONTROL_PATTERN": the pattern
 * alone admits word-bearing tokens such as `my_private_note`, so a route param
 * that merely *looks* like a token could still smuggle a phrase into a report.
 * Only a member of this table is ever attached. A later error-state deep link
 * (#2898 AC24, deferred) adds its error codes here rather than widening the
 * check.
 */
export const FEEDBACK_CONTROL_TOKENS = {
  shellHeader: 'shell.header.send_feedback',
  settingsRow: 'settings.row.send_feedback',
} as const;

export type FeedbackControlToken =
  (typeof FEEDBACK_CONTROL_TOKENS)[keyof typeof FEEDBACK_CONTROL_TOKENS];

const KNOWN_TOKENS: ReadonlySet<string> = new Set(Object.values(FEEDBACK_CONTROL_TOKENS));

function isControlToken(raw: string): raw is FeedbackControlToken {
  return KNOWN_TOKENS.has(raw);
}

/**
 * Accept `raw` only when it is one of {@link FEEDBACK_CONTROL_TOKENS} AND fits
 * the server's token shape; anything else -- prose, a URL, an exception
 * message, a number -- becomes `undefined` and is simply not attached.
 */
export function parseControlToken(raw: unknown): FeedbackControlToken | undefined {
  if (typeof raw !== 'string' || raw.length > FEEDBACK_CONTROL_MAX_LENGTH) return undefined;
  if (!CONTROL_PATTERN.test(raw)) return undefined;
  return isControlToken(raw) ? raw : undefined;
}
