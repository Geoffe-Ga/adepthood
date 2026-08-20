/* eslint-env jest */
/* global describe, it, expect, beforeEach, afterEach, jest */

import { initErrorMonitoring, reportException } from '../sentry';

const DSN_ENV = 'EXPO_PUBLIC_SENTRY_DSN';
const ENVIRONMENT_ENV = 'EXPO_PUBLIC_SENTRY_ENVIRONMENT';
const RELEASE_ENV = 'EXPO_PUBLIC_SENTRY_RELEASE';

const DSN = 'https://examplepublickey@o0.ingest.sentry.io/42';

// What a user wrote. The point of every "quiet side" assertion below.
const JOURNAL_SENTINEL = 'sat with the grief about my father and did not look away';

const ORIGINAL_ENV = { ...process.env };

interface SentPayload {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let sent: SentPayload[];
let fetchMock: jest.Mock;
let consoleError: jest.SpyInstance;
let consoleInfo: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeEach(() => {
  sent = [];
  fetchMock = jest.fn((url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: init.body });
    return Promise.resolve({ ok: true });
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchMock,
    configurable: true,
    writable: true,
  });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  process.env = { ...ORIGINAL_ENV };
  delete process.env[DSN_ENV];
  delete process.env[ENVIRONMENT_ENV];
  delete process.env[RELEASE_ENV];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env[DSN_ENV];
  // Leave the module inert so no later test can post anywhere. Done while the
  // console spies are still installed, so its startup line stays out of the
  // test output.
  initErrorMonitoring();
  consoleError.mockRestore();
  consoleInfo.mockRestore();
  consoleWarn.mockRestore();
});

/** Flush the microtask queue so an in-flight ``fetch`` promise settles. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** The single report this test expected to be delivered. */
function onlyReport(): SentPayload {
  const [first] = sent;
  if (!first) {
    throw new Error('expected exactly one delivered report, got none');
  }
  return first;
}

/** First argument of a console spy's first call, as a string. */
function firstLine(spy: jest.SpyInstance): string {
  return String(spy.mock.calls[0]?.[0]);
}

describe('with a DSN configured', () => {
  beforeEach(() => {
    process.env[DSN_ENV] = DSN;
    process.env[ENVIRONMENT_ENV] = 'production';
    process.env[RELEASE_ENV] = 'rel-9';
    consoleInfo.mockClear();
    expect(initErrorMonitoring()).toBe(true);
  });

  it('announces itself once at startup, naming environment and release', () => {
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    const line = firstLine(consoleInfo);
    expect(line).toContain('error_monitoring_enabled');
    expect(line).toContain('production');
    expect(line).toContain('rel-9');
    expect(line).not.toContain(DSN);
  });

  it('posts a crash to the envelope endpoint with the DSN auth header', async () => {
    reportException(new Error('render failed'), { errorBoundary: { boundary: 'ErrorBoundary' } });
    await settle();

    expect(sent).toHaveLength(1);
    expect(onlyReport().url).toBe('https://o0.ingest.sentry.io/api/42/envelope/');
    expect(onlyReport().headers['X-Sentry-Auth']).toContain('sentry_key=examplepublickey');
    expect(onlyReport().body).toContain('render failed');
  });

  it('cannot carry an entry body away, however long the message is', async () => {
    // The one field this design cannot close structurally is the exception
    // message, because it is authored at the throw site. reportException is
    // only ever called from the error boundaries, so in practice that message
    // is React's or a library's — but the cap is what bounds the damage if a
    // message somewhere does interpolate what the user was writing.
    const entry = `${JOURNAL_SENTINEL} `.repeat(40);

    reportException(new Error(`save failed for entry: ${entry}`), {
      react: { componentStack: '\n    in JournalScreen' },
    });
    await settle();

    expect(onlyReport().body).not.toContain(entry);
    expect(onlyReport().body).toContain('[truncated]');
  });

  it('carries no user identity — no email, no name, no id', async () => {
    reportException(new Error('render failed'));
    await settle();

    const [, , body = ''] = onlyReport().body.split('\n');
    const payload = JSON.parse(body) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('user');
  });

  it('sends no breadcrumbs at all — there is no buffer to leak', async () => {
    reportException(new Error('boom'));
    await settle();

    expect(onlyReport().body).not.toContain('breadcrumb');
  });

  it('still writes the crash to the console, so the report is never the only record', () => {
    reportException(new Error('render failed'));

    expect(consoleError).toHaveBeenCalled();
  });

  it('does not throw when the vendor is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network request failed'));

    expect(() => {
      reportException(new Error('render failed'));
    }).not.toThrow();
    await settle();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe('with no DSN configured', () => {
  it('runs normally and says so exactly once', () => {
    expect(initErrorMonitoring()).toBe(false);

    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(firstLine(consoleInfo)).toContain('error_monitoring_disabled');
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('reports nowhere but keeps logging the crash locally', () => {
    initErrorMonitoring();

    reportException(new Error('render failed'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});

describe('with an unusable DSN', () => {
  beforeEach(() => {
    process.env[DSN_ENV] = 'nonsense';
  });

  it('warns once, naming the variable but never echoing its value', () => {
    expect(initErrorMonitoring()).toBe(false);

    expect(consoleWarn).toHaveBeenCalledTimes(1);
    const line = firstLine(consoleWarn);
    expect(line).toContain(DSN_ENV);
    expect(line).not.toContain('nonsense');
  });

  it('keeps the app reporting crashes to the console', () => {
    initErrorMonitoring();

    reportException(new Error('render failed'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
  });
});
