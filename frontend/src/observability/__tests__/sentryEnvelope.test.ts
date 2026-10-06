/* eslint-env jest */
/* global describe, it, expect */

import { buildEvent, parseDsn, redactCredentials, serializeEnvelope } from '../sentryEnvelope';
import { MESSAGE_WITHHELD, REDACTED, UNKNOWN_ERROR_TYPE } from '../sentryEnvelope';

const DSN = 'https://examplepublickey@o0.ingest.sentry.io/42';

// Stands in for what a user wrote. A crash report that carries this is a
// privacy failure worse than the invisibility the reporter exists to fix.
const JOURNAL_SENTINEL = 'sat with the grief about my father and did not look away';

// Synthetic canaries standing in for what a user wrote, in every shape a
// serialiser could treat differently (#3064). Mirrors the backend set in
// backend/tests/helpers/telemetry_canaries.py.
const SENTINELS = [
  'SYNTHETIC_JOURNAL_CANARY_20261005',
  `SYNTHETIC_LONG_CANARY_${'x'.repeat(600)}`,
  'SYNTHETIC_UNICODE_CANARY_u\u0308n\u0301i_日本語',
  'SYNTHETIC_MULTILINE_CANARY line one\nline two\r\nline three',
  'SYNTHETIC_RTL_CANARY \u05e9\u05dc\u05d5\u05dd \u0645\u0631\u062d\u0628\u0627',
  'SYNTHETIC_EMOJI_CANARY \u{1F56F}\uFE0F\u{1F9E1}',
];

const PROBE_CHARS = 40;
const SENT_AT = '2026-08-14T12:00:01.000Z';

/** Every fragment of a canary whose presence in a payload means it leaked. */
function probes(canary: string): string[] {
  return canary
    .split(/\r?\n/)
    .map((line) => line.trim().slice(0, PROBE_CHARS))
    .filter(Boolean)
    .flatMap((head) => [head, JSON.stringify(head).slice(1, -1)]);
}

/** What actually goes on the wire for one thrown value. */
function wire(thrown: unknown): string {
  return serializeEnvelope(buildEvent(thrown, undefined, META), DSN, SENT_AT);
}

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

  it.each(['Error', 'TypeError', 'ApiValidationError', 'AbortError', 'DOMException'])(
    'keeps the class-shaped type %s',
    (name) => {
      const error = new Error('boom');
      error.name = name;

      expect(buildEvent(error, undefined, META).exception).toEqual({
        values: [{ type: name, value: MESSAGE_WITHHELD }],
      });
    },
  );

  it('carries the exception type and withholds the message', () => {
    const event = buildEvent(new TypeError('cannot read property of undefined'), undefined, META);

    expect(event.exception).toEqual({
      values: [{ type: 'TypeError', value: MESSAGE_WITHHELD }],
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

  it('ships no credential that reached the exception message', () => {
    const payload = wire(new Error('refresh failed: Bearer abcdef0123456789'));

    expect(payload).not.toContain('abcdef0123456789');
    expect(payload).toContain(MESSAGE_WITHHELD);
  });

  it('ships none of a message long enough to have swallowed an entry body', () => {
    const payload = wire(new Error(JOURNAL_SENTINEL.repeat(40)));

    expect(payload).not.toContain(JOURNAL_SENTINEL);
    expect(payload).not.toContain('[truncated]');
  });

  it('withholds even a short, harmless-looking message', () => {
    const payload = wire(new Error('render failed'));

    expect(payload).not.toContain('render failed');
    expect(payload).toContain(MESSAGE_WITHHELD);
  });

  it('reports a thrown non-Error by a fixed type, never by its text', () => {
    const event = buildEvent('a string was thrown', undefined, META);

    expect(event.exception).toEqual({
      values: [{ type: UNKNOWN_ERROR_TYPE, value: MESSAGE_WITHHELD }],
    });
  });

  it('tags the environment and release so staging is distinguishable', () => {
    const event = buildEvent(new Error('boom'), undefined, META);

    expect(event.environment).toBe('production');
    expect(event.release).toBe('rel-9');
  });

  it.each([
    ['spaces', 'my father said'],
    ['a newline', 'Error\nentry text'],
    ['an empty string', ''],
    ['a single word', 'grief'],
    ['prose that merely ends in Error', 'my father said there was an Error'],
    ['a lowercase word ending in Error', 'griefError'],
  ])('reports a name with %s as plain Error, since `name` is writable', (_label, name) => {
    const error = new Error('boom');
    error.name = name;

    expect(buildEvent(error, undefined, META).exception).toEqual({
      values: [{ type: 'Error', value: MESSAGE_WITHHELD }],
    });
  });
});

describe('the wire payload carries no user content (#3064)', () => {
  it.each(SENTINELS)('never ships a canary thrown as an Error message %#', (canary) => {
    const payload = wire(new Error(canary));

    probes(canary).forEach((probe) => expect(payload).not.toContain(probe));
  });

  it.each(SENTINELS)('never ships a canary thrown bare %#', (canary) => {
    const thrown: unknown[] = [canary, { toString: () => canary }, [canary]];

    thrown.forEach((value) => {
      const payload = wire(value);
      probes(canary).forEach((probe) => expect(payload).not.toContain(probe));
    });
  });

  it.each(SENTINELS)('never ships a canary assigned to an Error name %#', (canary) => {
    const error = new Error('boom');
    error.name = canary;

    const payload = wire(error);

    probes(canary).forEach((probe) => expect(payload).not.toContain(probe));
  });

  it.each(SENTINELS)('never ships a canary riding on a non-string name %#', (canary) => {
    const error = new Error('boom');
    // `name` is typed as a string but is an ordinary writable property; an
    // object whose string form is class-shaped would pass a coerced check
    // and then serialise its own fields.
    Object.defineProperty(error, 'name', {
      value: { toString: () => 'XError', note: canary },
    });

    const payload = wire(error);

    probes(canary).forEach((probe) => expect(payload).not.toContain(probe));
    expect(buildEvent(error, undefined, META).exception).toEqual({
      values: [{ type: 'Error', value: MESSAGE_WITHHELD }],
    });
  });

  it.each([42, null, undefined])('reports a thrown %p as UnknownError', (thrown) => {
    const [, , payload = ''] = wire(thrown).split('\n');

    expect(JSON.parse(payload)).toMatchObject({
      exception: { values: [{ type: UNKNOWN_ERROR_TYPE, value: MESSAGE_WITHHELD }] },
    });
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
