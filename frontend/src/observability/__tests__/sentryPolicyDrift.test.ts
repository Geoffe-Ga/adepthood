/* eslint-env jest */
/* global describe, it, expect */
/**
 * The privacy policy's Sentry paragraph describes the report this app sends
 * from the device, field for field (#3057).
 *
 * `buildEvent` writes every key of a client crash report by hand. Each key is
 * either disclosed in the policy, under the words below, or is report
 * bookkeeping that says nothing about the person. A key added to `buildEvent`
 * without a line in the policy fails here; so does a policy that stops naming
 * a field the app still sends, or that drops the line about the device's
 * network address.
 *
 * Reading the policy through `@/testing/backendSource` is what makes
 * `backend-ci.yml` run this file on a docs-only change to the policy.
 */
import * as fs from 'fs';
import * as path from 'path';

import { buildEvent, MESSAGE_WITHHELD } from '../sentryEnvelope';

import { REPO_ROOT } from '@/testing/backendSource';

const POLICY = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'legal', 'privacy-policy.md'), 'utf-8');

/** Each disclosed event key, and the words the policy discloses it under. */
const DISCLOSED_EVENT_KEYS: Record<string, string> = {
  environment: 'environment',
  release: 'release',
  exception: "the error's type",
};

/** Each disclosed context, and the words the policy discloses it under. */
const DISCLOSED_CONTEXTS: Record<string, string> = {
  react: 'component stack',
  errorBoundary: 'which error screen caught it',
};

/** Keys every Sentry event carries that describe the report, not the person. */
const BOOKKEEPING_KEYS = ['event_id', 'timestamp', 'platform', 'level'];

function normalise(text: string): string {
  return text.toLowerCase().replace(/[*`]/g, '').split(/\s+/).join(' ');
}

/** The policy's Sentry paragraphs: from its lead-in to the next party's. */
const sentryParagraphs = (() => {
  const policy = normalise(POLICY);
  const start = policy.indexOf('sentry, if');
  const end = policy.indexOf('an email relay', start);
  return start === -1 || end === -1 ? '' : policy.slice(start, end);
})();

/** A client report with every optional context present. */
function fullEvent(): Record<string, unknown> {
  return buildEvent(
    new TypeError('a message that must never ship'),
    {
      react: { componentStack: '\n    in JournalEntryScreen' },
      errorBoundary: { boundary: 'feature', name: 'Journal' },
    },
    {
      eventId: 'e'.repeat(32),
      timestamp: '2026-10-07T00:00:00.000Z',
      environment: 'production',
      release: 'r1',
    },
  );
}

describe('privacy policy vs the client crash report', () => {
  it('finds the Sentry paragraphs', () => {
    expect(sentryParagraphs).not.toBe('');
  });

  it('every key buildEvent writes is either disclosed or bookkeeping', () => {
    const keys = Object.keys(fullEvent()).filter((key) => key !== 'contexts');

    expect(keys.sort()).toEqual([...Object.keys(DISCLOSED_EVENT_KEYS), ...BOOKKEEPING_KEYS].sort());
  });

  it('every context buildEvent attaches is disclosed', () => {
    const contexts = fullEvent().contexts as Record<string, unknown>;

    expect(Object.keys(contexts).sort()).toEqual(Object.keys(DISCLOSED_CONTEXTS).sort());
  });

  it('the policy names each disclosed field the app sends from the device', () => {
    for (const words of [
      ...Object.values(DISCLOSED_EVENT_KEYS),
      ...Object.values(DISCLOSED_CONTEXTS),
    ]) {
      expect(sentryParagraphs).toContain(words);
    }
  });

  it('the message is withheld on the device, and the policy says so', () => {
    const exception = fullEvent().exception as { values: { value: string }[] };

    expect(exception.values[0]?.value).toBe(MESSAGE_WITHHELD);
    expect(sentryParagraphs).toContain('reported straight from your device');
    expect(sentryParagraphs).toContain('message is withheld');
  });

  it('the policy says Sentry sees the network address a device report comes from', () => {
    expect(sentryParagraphs).toContain('network address');
  });

  it('the policy does not say every report comes from the server', () => {
    expect(sentryParagraphs).not.toContain('a report is made only when the server');
  });
});
