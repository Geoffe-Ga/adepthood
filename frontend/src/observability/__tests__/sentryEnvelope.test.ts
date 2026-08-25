/* eslint-env jest */
/* global describe, it, expect */

import { buildEvent, parseDsn, redactCredentials, serializeEnvelope } from '../sentryEnvelope';
import { MAX_MESSAGE_CHARS, REDACTED } from '../sentryEnvelope';

const DSN = 'https://examplepublickey@o0.ingest.sentry.io/42';

// Stands in for what a user wrote. A crash report that carries this is a
// privacy failure worse than the invisibility the reporter exists to fix.
const JOURNAL_SENTINEL = 'sat with the grief about my father and did not look away';

const META = {
  eventId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
  timestamp: '2026-08-14T12:00:00.000Z',
  environment: 'production',
  release: 'rel-9',
};

describe('parseDsn', () => {
  it('derives the envelope endpoint and the auth header from a DSN', () => {
    expect(parseDsn(DSN)).toEqual({
      envelopeUrl: 'https://o0.ingest.sentry.io/api/42/envelope/',
      authHeader: expect.stringContaining('sentry_key=examplepublickey') as unknown as string,
    });
  });

  it('keeps a path prefix in front of the api segment', () => {
    expect(parseDsn('https://key@example.test/sentry/7')?.envelopeUrl).toBe(
      'https://example.test/sentry/api/7/envelope/',
    );
  });

  it('advertises the protocol version the payload is written to', () => {
    expect(parseDsn(DSN)?.authHeader).toContain('sentry_version=7');
  });

  it.each([
    ['empty', ''],
    ['not a url', 'nonsense'],
    ['no public key', 'https://o0.ingest.sentry.io/42'],
    ['no project id', 'https://key@o0.ingest.sentry.io/'],
    ['wrong scheme', 'ftp://key@o0.ingest.sentry.io/42'],
  ])('rejects a DSN with %s rather than guessing', (_label, dsn) => {
    expect(parseDsn(dsn)).toBeNull();
  });
});

describe('redactCredentials', () => {
  it.each([
    ['a bearer token', 'failed: Bearer abcdef0123456789'],
    ['a JWT', 'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.dBjftJeZ4CVP'],
    ['an api key', 'key sk-abcdef0123456789'],
  ])('redacts %s', (_label, text) => {
    const redacted = redactCredentials(text);

    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain('abcdef0123456789');
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1');
  });

  it('leaves text with no credential in it byte-identical', () => {
    const benign = 'Network request failed while loading /journal/entries';

    expect(redactCredentials(benign)).toBe(benign);
  });
});

describe('buildEvent', () => {
  it('emits only allow-listed top-level fields', () => {
    const event = buildEvent(new Error('render failed'), undefined, META);

    // An allow-list assertion, not a spot check: a future field can only be
    // added by changing this list, which is where the sensitivity review is.
    expect(Object.keys(event).sort()).toEqual([
      'contexts',
      'environment',
      'event_id',
      'exception',
      'level',
      'platform',
      'release',
      'timestamp',
    ]);
  });

  it('carries the exception type and message so the report is actionable', () => {
    const event = buildEvent(new TypeError('cannot read property of undefined'), undefined, META);

    expect(event.exception).toEqual({
      values: [{ type: 'TypeError', value: 'cannot read property of undefined' }],
    });
  });

  it('copies only the two allow-listed contexts', () => {
    const event = buildEvent(
      new Error('boom'),
      {
        react: { componentStack: '\n    in JournalScreen' },
        errorBoundary: { boundary: 'FeatureErrorBoundary', name: 'Journal' },
      },
      META,
    );

    expect(event.contexts).toEqual({
      react: { componentStack: '\n    in JournalScreen' },
      errorBoundary: { boundary: 'FeatureErrorBoundary', name: 'Journal' },
    });
  });

  it('never carries breadcrumbs, request data, or extra', () => {
    const event = buildEvent(new Error('boom'), undefined, META);

    expect(event).not.toHaveProperty('breadcrumbs');
    expect(event).not.toHaveProperty('request');
    expect(event).not.toHaveProperty('extra');
    expect(event).not.toHaveProperty('user');
  });

  it('redacts a credential that reached the exception message', () => {
    const event = buildEvent(new Error('refresh failed: Bearer abcdef0123456789'), undefined, META);

    expect(JSON.stringify(event)).not.toContain('abcdef0123456789');
    expect(JSON.stringify(event)).toContain(REDACTED);
  });

  it('caps a message long enough to have swallowed an entry body', () => {
    const overlong = JOURNAL_SENTINEL.repeat(40);

    const event = buildEvent(new Error(overlong), undefined, META);
    const serialised = JSON.stringify(event);

    expect(serialised.length).toBeLessThan(overlong.length);
    expect(serialised).toContain('[truncated]');
  });

  it('leaves a short message whole', () => {
    const event = buildEvent(new Error('render failed'), undefined, META);

    expect(JSON.stringify(event)).toContain('render failed');
  });

  it('reports a thrown non-Error without inventing a type', () => {
    const event = buildEvent('a string was thrown', undefined, META);

    expect(event.exception).toEqual({
      values: [{ type: 'UnknownError', value: 'a string was thrown' }],
    });
  });

  it('tags the environment and release so staging is distinguishable', () => {
    const event = buildEvent(new Error('boom'), undefined, META);

    expect(event.environment).toBe('production');
    expect(event.release).toBe('rel-9');
  });

  it('caps the message at the documented length', () => {
    const event = buildEvent(new Error('y'.repeat(MAX_MESSAGE_CHARS + 100)), undefined, META);
    const { values } = event.exception as { values: [{ value: string }] };
    const value = values[0].value;

    expect(value.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + '…[truncated]'.length);
  });
});

describe('serializeEnvelope', () => {
  it('writes the three newline-separated envelope lines Sentry expects', () => {
    const event = buildEvent(new Error('boom'), undefined, META);

    const [envelopeHeader = '', itemHeader = '', payload = ''] = serializeEnvelope(
      event,
      DSN,
      META.timestamp,
    ).split('\n');

    expect(JSON.parse(envelopeHeader)).toEqual({
      event_id: META.eventId,
      sent_at: META.timestamp,
      dsn: DSN,
    });
    expect(JSON.parse(itemHeader)).toEqual({ type: 'event', content_type: 'application/json' });
    expect(JSON.parse(payload)).toEqual(event);
  });

  it('never emits a raw newline inside the payload line', () => {
    // The item header omits ``length``, so Sentry reads the payload to the next
    // newline. A component stack is full of newlines; JSON escapes them, and
    // this is the assertion that keeps that true.
    const event = buildEvent(new Error('boom'), { react: { componentStack: '\n a \n b' } }, META);

    expect(serializeEnvelope(event, DSN, META.timestamp).split('\n')).toHaveLength(3);
  });
});
