/**
 * Every string the beta feedback inbox shows, in one place.
 *
 * The inbox is an operator tool, so the copy is plain and procedural. Two
 * sentences carry weight: the non-admin state says what this place is without
 * suggesting the reader did something wrong, and the draft panel says plainly
 * that nothing is published from here.
 */

export const INBOX_TITLE = 'Beta feedback inbox';
export const INBOX_EYEBROW = 'Operators only';
export const INBOX_LEAD =
  'Read, sort and summarise what beta testers reported. Reporters never see anything you add here.';

export const SETTINGS_SECTION_TITLE = 'Beta operations';
export const SETTINGS_ROW_LABEL = INBOX_TITLE;
export const SETTINGS_ROW_DESCRIPTION =
  'Triage private beta reports and prepare issue drafts. Visible because this account is an operator.';

export const CHECKING_ACCESS = 'Checking access…';
export const NOT_AN_OPERATOR =
  'This area is for the people who run the beta. Your account can file feedback from Settings, but it cannot open the inbox.';
export const ACCESS_UNAVAILABLE =
  'Could not confirm access to the inbox. Check your connection and try again.';

export const FILTER_ALL = 'All';
export const EMPTY_INBOX = 'No reports match this filter.';
export const LOAD_FAILED = 'Could not load reports. Check your connection and try again.';
export const LOAD_MORE = 'Load more';
export const RETRY = 'Try again';
export const BACK_TO_INBOX = 'Back to inbox';
export const SELECT_A_REPORT = 'Choose a report to read it.';

export const SECTION_REPORTER_SAID = 'Reporter said';
export const SECTION_APP_ATTACHED = 'App attached';
export const SECTION_OPERATOR_ADDED = 'Operator added';
export const SECTION_SIBLINGS = 'Similar reports';

export const LABEL_SUMMARY = 'Summary';
export const LABEL_INTENT = 'Trying to';
export const LABEL_EXPECTED = 'Expected';
export const LABEL_ACTUAL = 'What happened';
export const LABEL_SCREEN = 'Screen';
export const LABEL_CONTROL = 'Control';
export const LABEL_PLATFORM = 'Platform';
export const LABEL_BUILD = 'Build';
export const LABEL_VIEWPORT = 'Viewport';
export const LABEL_LOCALE = 'Locale';
export const LABEL_CORRELATION = 'Correlation id';
export const LABEL_FILED = 'Filed';
export const LABEL_STATUS = 'Status';
export const LABEL_DUPLICATE_OF = 'Duplicate of';
export const LABEL_DUPLICATES = 'Marked as duplicates of this';
export const LABEL_NOTES = 'Private notes';
export const LABEL_TRAIL = 'Audit trail';
export const NOT_PROVIDED = 'Not provided';
export const NONE = 'None';
export const NO_SIBLINGS = 'No other report shares this fingerprint.';

export const MOVE_TO = (status: string): string => `Move to ${status}`;
export const DUPLICATE_TARGET_LABEL = 'Canonical report reference, e.g. FB-7K3M9Q2B';
export const LINK_DUPLICATE = 'Mark as duplicate';
export const UNLINK_DUPLICATE = 'Clear duplicate link';
export const NOTE_FIELD_LABEL = 'New private note';
export const ADD_NOTE = 'Add note';
export const ACTION_FAILED = 'That change was not saved. Refresh the report and try again.';

export const DRAFT_HEADING = 'Issue draft';
export const DRAFT_EXPLAINER =
  "The draft contains only what you write here, plus these details: category, impact, screen, control or error code, build family, platform, viewport class, locale, and the report references. The reporter's own words are never included, and nor is their account. Nothing is sent anywhere: copy it or download it.";
export const DRAFT_TITLE_LABEL = 'Issue title, in your own words';
export const DRAFT_SUMMARY_LABEL = 'Summary, in your own words';
export const DRAFT_INCLUDE_NOTE = (id: number): string => `Include note ${id} in the draft`;
export const GENERATE_DRAFT = 'Prepare draft';
export const COPY_DRAFT = 'Copy';
export const DOWNLOAD_DRAFT = 'Download';
export const COPIED = 'Copied to the clipboard.';
export const COPY_FAILED = 'Could not copy on this device. Download the draft instead.';
export const DOWNLOADED = (filename: string): string => `Saved ${filename}.`;
export const DRAFT_FAILED = 'Could not prepare the draft. Try again.';
export const DRAFT_MEDIA_TYPE = 'text/markdown;charset=utf-8';
