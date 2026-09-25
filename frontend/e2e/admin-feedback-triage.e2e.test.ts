import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { freshLicenseKey } from './licenseKey';

import { adminFeedback, ApiError, auth, feedback, setTokenGetter, users } from '@/api';

/**
 * The operator's side of private beta feedback, across the seam (#2900).
 *
 * A tester files a report through the production client; a second account is
 * made an operator in the lane's database (``is_admin`` has no HTTP writer, by
 * design -- see ``backend/tests/e2e/promote_admin.py``); and then the operator
 * drives the inbox through the same client: the capability probe, the list, the
 * detail, a transition, a note, and a draft. The reporter, asking the same
 * questions, is refused at every one.
 *
 * The draft assertions are the point of running this live rather than in
 * process: the reporter's address and the correlation id their client attached
 * are real values on a real row, and neither may appear in what the operator is
 * handed to paste into a tracker.
 *
 * #2899 extends it to the epic's exit criteria. The reporter files the two
 * reports the browser journeys file -- a compact-Journal "broken" and a
 * wide-Map "confusing" -- because the browser lane and this lane do not share a
 * database; the operator retrieves both and sees each one's three sources kept
 * apart. A bystander account is refused every operator question (actions
 * included) and the reporter's receipt, and neither refusal moves the report.
 * Last, the reporter's export carries both reports, and after the account is
 * erased the operator can no longer open or list either.
 */

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const PROMOTE_MODULE = 'tests.e2e.promote_admin';
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const PAGE = { limit: 50, offset: 0 };
const REPORTS_FILED = 2;

const reporterEmail = `e2e-feedback-reporter-${randomUUID()}${EMAIL_DOMAIN}`;
const operatorEmail = `e2e-feedback-operator-${randomUUID()}${EMAIL_DOMAIN}`;
const bystanderEmail = `e2e-feedback-bystander-${randomUUID()}${EMAIL_DOMAIN}`;
const correlationId = randomUUID();
const summary = `The habit card vanished — ${randomUUID()}`;
// Each prose slot carries its own sentinel, so a leak names the column it came from.
const intentSentinel = `I was logging this morning's sit — ${randomUUID()}`;
const expectedSentinel = `The shelf stays put — ${randomUUID()}`;
const actualSentinel = `It went blank; mail me at ${reporterEmail}`;
const mapSummary = `I could not tell which stage I was on — ${randomUUID()}`;
const mapIntentSentinel = `Find where the course starts — ${randomUUID()}`;
const note = `Seen twice on Android — ${randomUUID()}`;
// What the draft must carry for the Journal report, as ``render_issue_draft`` labels it.
const DRAFT_EVIDENCE_LINES = [
  '- Screen: `journal.shelf`',
  '- Control: `shell.header.send_feedback`',
  '- Platform: `web`',
  '- Build family: `1.4`',
  '- Viewport: `compact`',
  '- Locale: `en-US`',
];
const OPERATOR_TEXT = {
  title: 'Habit card blanks after accepting an offer',
  summary: 'Accepting a habit offer on the shelf blanks the card.',
  noteIds: [],
};

let reporterToken: string | null = null;
let operatorToken: string | null = null;
let bystanderToken: string | null = null;
let publicId = '';
let mapPublicId = '';

/** Every piece of the reporter's own writing, across both reports. */
function reporterProse(): string[] {
  return [summary, intentSentinel, expectedSentinel, actualSentinel, mapSummary, mapIntentSentinel];
}

function actAs(token: string | null): void {
  setTokenGetter(() => token);
}

async function refusal(call: () => Promise<unknown>): Promise<number> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw error;
  }
  throw new Error('expected the call to be refused, but it succeeded');
}

describe('admin feedback triage journey against a live server', () => {
  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers a reporter and an operator-to-be', async () => {
    const reporter = await auth.signup({
      email: reporterEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    const operator = await auth.signup({
      email: operatorEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    const bystander = await auth.signup({
      email: bystanderEmail,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    reporterToken = reporter.token;
    operatorToken = operator.token;
    bystanderToken = bystander.token;

    expect(new Set([reporter.user_id, operator.user_id, bystander.user_id]).size).toBe(3);
  });

  it('files a report as the reporter', async () => {
    actAs(reporterToken);
    const receipt = await feedback.submit(
      {
        category: 'broken',
        impact: 'blocked',
        summary,
        intent: intentSentinel,
        expected: expectedSentinel,
        actual: actualSentinel,
        context: {
          screen: 'journal.shelf',
          control: 'shell.header.send_feedback',
          platform: 'web',
          app_build: '1.4.2+318',
          viewport_class: 'compact',
          locale: 'en-US',
          correlation_id: correlationId,
        },
      },
      randomUUID(),
    );
    publicId = receipt.public_id;

    expect(publicId).toMatch(/^FB-/);
  });

  it('files a second report, confusing, from the wide Map', async () => {
    actAs(reporterToken);
    const receipt = await feedback.submit(
      {
        category: 'confusing',
        impact: 'can_continue',
        summary: mapSummary,
        intent: mapIntentSentinel,
        context: {
          screen: 'map.stages',
          control: 'shell.header.send_feedback',
          platform: 'web',
          app_build: '1.4.2+318',
          viewport_class: 'expanded',
          locale: 'en-US',
        },
      },
      randomUUID(),
    );
    mapPublicId = receipt.public_id;

    expect(mapPublicId).toMatch(/^FB-/);
    expect(mapPublicId).not.toBe(publicId);
  });

  it('refuses the reporter every operator question, their own report included', async () => {
    actAs(reporterToken);

    expect(await refusal(() => adminFeedback.capabilities())).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.list({}, { limit: 10, offset: 0 }))).toBe(
      HTTP_FORBIDDEN,
    );
    expect(await refusal(() => adminFeedback.detail(publicId))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.transition(publicId, 'triaged'))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.addNote(publicId, note))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.draft(publicId, OPERATOR_TEXT))).toBe(HTTP_FORBIDDEN);
  });

  it('refuses a bystander every operator question and the reporter`s receipt', async () => {
    actAs(bystanderToken);

    expect(await refusal(() => adminFeedback.capabilities())).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.list({}, PAGE))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.detail(publicId))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.transition(publicId, 'triaged'))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.addNote(publicId, note))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.draft(publicId, OPERATOR_TEXT))).toBe(HTTP_FORBIDDEN);
    // Somebody else's reference reads exactly like one never issued.
    expect(await refusal(() => feedback.receipt(publicId))).toBe(HTTP_NOT_FOUND);
  });

  it('confirms the operator once the lane database says so', async () => {
    const promoted = JSON.parse(
      runBackendModule(PROMOTE_MODULE, ['promote', '--email', operatorEmail]),
    ) as { is_admin: boolean };
    expect(promoted.is_admin).toBe(true);

    actAs(operatorToken);
    expect(await adminFeedback.capabilities()).toEqual({ feedback_triage: true });
  });

  it('finds both reports untouched by every refused action', async () => {
    actAs(operatorToken);
    const page = await adminFeedback.list({ status: 'new' }, PAGE);
    const listed = page.items.map((item) => item.public_id);
    expect(listed).toContain(publicId);
    expect(listed).toContain(mapPublicId);

    for (const id of [publicId, mapPublicId]) {
      const untouched = await adminFeedback.detail(id);
      expect(untouched.operator_added.status).toBe('new');
      expect(untouched.operator_added.notes).toHaveLength(0);
      expect(untouched.operator_added.events).toHaveLength(0);
    }
  });

  it('keeps what the reporter said, what the app attached and what the operator added apart', async () => {
    actAs(operatorToken);
    const journal = await adminFeedback.detail(publicId);
    expect(journal.category).toBe('broken');
    expect(journal.reporter_said).toEqual({
      summary,
      intent: intentSentinel,
      expected: expectedSentinel,
      actual: actualSentinel,
    });
    expect(journal.app_attached).toMatchObject({
      screen: 'journal.shelf',
      control: 'shell.header.send_feedback',
      platform: 'web',
      viewport_class: 'compact',
      locale: 'en-US',
      correlation_id: correlationId,
    });

    const map = await adminFeedback.detail(mapPublicId);
    expect(map.category).toBe('confusing');
    expect(map.reporter_said).toEqual({
      summary: mapSummary,
      intent: mapIntentSentinel,
      expected: null,
      actual: null,
    });
    expect(map.app_attached).toMatchObject({
      screen: 'map.stages',
      viewport_class: 'expanded',
      correlation_id: null,
    });

    // Nothing the reporter wrote is filed under what the app attached or the operator added.
    for (const detail of [journal, map]) {
      const notReporter = JSON.stringify([detail.app_attached, detail.operator_added]);
      for (const prose of reporterProse()) expect(notReporter).not.toContain(prose);
    }
  });

  it('lists, opens, triages and annotates the report', async () => {
    actAs(operatorToken);
    const opened = await adminFeedback.detail(publicId);
    expect(opened.allowed_transitions).toEqual(['closed', 'triaged']);

    const triaged = await adminFeedback.transition(publicId, 'triaged');
    expect(triaged.operator_added.status).toBe('triaged');

    const noted = await adminFeedback.addNote(publicId, note);
    expect(noted.operator_added.notes.map((entry) => entry.body)).toEqual([note]);
    expect(noted.operator_added.events.map((event) => event.action)).toEqual([
      'status_changed',
      'note_added',
    ]);
  });

  it('drafts an issue from the operator`s words that carries none of the reporter', async () => {
    actAs(operatorToken);
    const opened = await adminFeedback.detail(publicId);
    const noteId = opened.operator_added.notes[0]?.id ?? 0;

    const unquoted = await adminFeedback.draft(publicId, OPERATOR_TEXT);
    const quoted = await adminFeedback.draft(publicId, { ...OPERATOR_TEXT, noteIds: [noteId] });

    for (const draft of [unquoted, quoted]) {
      const text = `${draft.title}\n${draft.markdown}`;
      expect(text).toContain(publicId);
      expect(draft.source_public_ids).toContain(publicId);
      // The reproduction evidence is the envelope, each value on its own labelled line.
      for (const line of DRAFT_EVIDENCE_LINES) expect(draft.markdown).toContain(line);
      expect(text).not.toContain(reporterEmail);
      expect(text).not.toContain(correlationId);
      expect(text).not.toMatch(/^- (User|Account|Reporter)\b/im);
      // The reporter's words are never published (#2900 finding [5]).
      for (const prose of reporterProse()) expect(text).not.toContain(prose);
      expect(text).not.toContain('It went blank');
      expect(text).toContain(OPERATOR_TEXT.summary);
    }
    expect(unquoted.markdown).not.toContain(note);
    expect(quoted.markdown).toContain(note);
  });

  it('leaves the reporter`s receipt exactly as it was', async () => {
    actAs(reporterToken);
    const receipt = await feedback.receipt(publicId);

    expect(Object.keys(receipt).sort()).toEqual(['category', 'created_at', 'impact', 'public_id']);
  });

  it('exports both reports with the reporter`s own words', async () => {
    actAs(reporterToken);
    const archive = await users.exportMyData();
    const reports = archive.records.feedback_reports ?? [];

    expect(reports).toHaveLength(REPORTS_FILED);
    const exported = JSON.stringify(reports);
    expect(exported).toContain(summary);
    expect(exported).toContain(mapSummary);
  });

  it('erases both reports with the account, out of the operator`s reach', async () => {
    actAs(reporterToken);
    await users.deleteMyAccount({ confirm_email: reporterEmail });

    actAs(operatorToken);
    expect(await refusal(() => adminFeedback.detail(publicId))).toBe(HTTP_NOT_FOUND);
    expect(await refusal(() => adminFeedback.detail(mapPublicId))).toBe(HTTP_NOT_FOUND);
    const listed = (await adminFeedback.list({}, PAGE)).items.map((item) => item.public_id);
    expect(listed).not.toContain(publicId);
    expect(listed).not.toContain(mapPublicId);
  });
});
