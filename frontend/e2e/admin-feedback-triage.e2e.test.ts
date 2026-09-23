import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { freshLicenseKey } from './licenseKey';

import { adminFeedback, ApiError, auth, feedback, setTokenGetter } from '@/api';

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
 */

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const PROMOTE_MODULE = 'tests.e2e.promote_admin';
const HTTP_FORBIDDEN = 403;

const reporterEmail = `e2e-feedback-reporter-${randomUUID()}${EMAIL_DOMAIN}`;
const operatorEmail = `e2e-feedback-operator-${randomUUID()}${EMAIL_DOMAIN}`;
const correlationId = randomUUID();
const summary = `The habit card vanished — ${randomUUID()}`;
const note = `Seen twice on Android — ${randomUUID()}`;

let reporterToken: string | null = null;
let operatorToken: string | null = null;
let publicId = '';

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
    reporterToken = reporter.token;
    operatorToken = operator.token;

    expect(reporter.user_id).not.toBe(operator.user_id);
  });

  it('files a report as the reporter', async () => {
    actAs(reporterToken);
    const receipt = await feedback.submit(
      {
        category: 'broken',
        impact: 'blocked',
        summary,
        actual: `It went blank; mail me at ${reporterEmail}`,
        context: {
          screen: 'journal.shelf',
          control: 'habit_offer.accept',
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

  it('refuses the reporter every operator question, their own report included', async () => {
    actAs(reporterToken);

    expect(await refusal(() => adminFeedback.capabilities())).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.list({}, { limit: 10, offset: 0 }))).toBe(
      HTTP_FORBIDDEN,
    );
    expect(await refusal(() => adminFeedback.detail(publicId))).toBe(HTTP_FORBIDDEN);
    expect(await refusal(() => adminFeedback.draft(publicId, []))).toBe(HTTP_FORBIDDEN);
  });

  it('confirms the operator once the lane database says so', async () => {
    const promoted = JSON.parse(
      runBackendModule(PROMOTE_MODULE, ['promote', '--email', operatorEmail]),
    ) as { is_admin: boolean };
    expect(promoted.is_admin).toBe(true);

    actAs(operatorToken);
    expect(await adminFeedback.capabilities()).toEqual({ feedback_triage: true });
  });

  it('lists, opens, triages and annotates the report', async () => {
    actAs(operatorToken);
    const page = await adminFeedback.list({ status: 'new' }, { limit: 50, offset: 0 });
    expect(page.items.map((item) => item.public_id)).toContain(publicId);

    const opened = await adminFeedback.detail(publicId);
    expect(opened.reporter_said.summary).toBe(summary);
    expect(opened.app_attached.correlation_id).toBe(correlationId);
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

  it('drafts an issue that carries the report and none of the reporter', async () => {
    actAs(operatorToken);
    const opened = await adminFeedback.detail(publicId);
    const noteId = opened.operator_added.notes[0]?.id ?? 0;

    const unquoted = await adminFeedback.draft(publicId, []);
    const quoted = await adminFeedback.draft(publicId, [noteId]);

    for (const draft of [unquoted, quoted]) {
      const text = `${draft.title}\n${draft.markdown}`;
      expect(text).toContain(publicId);
      expect(text).not.toContain(reporterEmail);
      expect(text).not.toContain(correlationId);
    }
    expect(unquoted.markdown).not.toContain(note);
    expect(quoted.markdown).toContain(note);
  });

  it('leaves the reporter`s receipt exactly as it was', async () => {
    actAs(reporterToken);
    const receipt = await feedback.receipt(publicId);

    expect(Object.keys(receipt).sort()).toEqual(['category', 'created_at', 'impact', 'public_id']);
  });
});
