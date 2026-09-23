import type { FeedbackTriageDetailT, FeedbackTriageSummaryT } from '@/api';

/** Prose that belongs to the reporter, and only ever in "Reporter said". */
export const REPORTER_PROSE = 'The habit card vanished when I tapped the offer.';
/** Prose that belongs to an operator, and only ever in "Operator added". */
export const OPERATOR_NOTE = 'Seen twice on Android too.';
export const CORRELATION = '0f0f0f0f-1111-4222-8333-444455556666';

export function summary(overrides: Partial<FeedbackTriageSummaryT> = {}): FeedbackTriageSummaryT {
  return {
    public_id: 'FB-23456789',
    status: 'new',
    category: 'broken',
    impact: 'blocked',
    screen: 'journal.shelf',
    app_build: '1.4.2+318',
    created_at: '2026-09-01T12:00:00+00:00',
    duplicate_of: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<FeedbackTriageDetailT> = {}): FeedbackTriageDetailT {
  return {
    public_id: 'FB-23456789',
    category: 'broken',
    impact: 'blocked',
    reporter_said: {
      summary: REPORTER_PROSE,
      intent: 'Log a sit.',
      expected: 'The card stays.',
      actual: 'It disappeared.',
    },
    app_attached: {
      screen: 'journal.shelf',
      control: 'habit_offer.accept',
      platform: 'ios',
      app_build: '1.4.2+318',
      viewport_class: 'compact',
      locale: 'en-US',
      correlation_id: CORRELATION,
      created_at: '2026-09-01T12:00:00+00:00',
    },
    operator_added: {
      status: 'triaged',
      duplicate_of: null,
      duplicates: [],
      notes: [{ id: 7, body: OPERATOR_NOTE, created_at: '2026-09-02T12:00:00+00:00' }],
      events: [
        {
          action: 'status_changed',
          old_state: 'new',
          new_state: 'triaged',
          created_at: '2026-09-02T11:00:00+00:00',
        },
      ],
    },
    fingerprint: '0123456789abcdef',
    siblings: [],
    allowed_transitions: ['closed', 'planned'],
    ...overrides,
  };
}
