/**
 * Bodies the client model must carry through parse → serialize untouched.
 *
 * Shared by the model suite, the inline-toggle property loop, and the live
 * mirror's parity test, so all three walk the same bodies.
 *
 * Frozen, and holding STRINGS rather than parsed documents, so the deliberate
 * mutation in "serializes only from the source stream" cannot leak into any
 * other case.
 *
 * Note: this is a CLIENT-MODEL corpus. `sanitize_user_text` on the backend
 * (backend/src/routers/journal.py -> backend/src/utils/text_sanitize.py) NFC
 * normalises and strips zero-width characters on save, so an end-to-end round
 * trip over the combining-mark and ZWJ entries below would be a false red on
 * deliberate security policy, not a bug.
 */
export const CORPUS: readonly string[] = Object.freeze([
  '',
  '\n',
  '\n\n\n',
  '***',
  'a **unclosed',
  'a *b _c*',
  'a \\*x\\* b',
  'éclair *bold*',
  '**\u{1F600}x**',
  '\u{1F468}‍\u{1F469}‍\u{1F467} tail',
  '*héllo* there',
  '>',
  '>\n> after',
  '>\tfoo',
  '\tindented\ttabs',
  '- one\n  - nested\n\t- tabbed',
  '+ plus\n* star\n- dash',
  'line\n',
  '  padded  ',
  'a <u>underlined</u> b',
  'a ==not underline== b',
  'Intro\n- one\n- two\n> quoted\nplain',
  '- a **b** _c_ <u>d</u>\n> e *f*',
  'snake_case and for_ward_',
]);
