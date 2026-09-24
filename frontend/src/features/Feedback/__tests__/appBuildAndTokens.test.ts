/* eslint-env jest */
/* global describe, it, expect */
import * as fs from 'fs';
import * as path from 'path';

import { APP_BUILD_FALLBACK, resolveAppBuild } from '@/features/Feedback/appBuild';
import { BUILD_PATTERN, FEEDBACK_BUILD_MAX_LENGTH } from '@/features/Feedback/feedbackBounds';
import {
  FEEDBACK_CONTROL_TOKENS,
  parseControlToken,
} from '@/features/Feedback/feedbackControlTokens';

const APP_JSON = path.resolve(__dirname, '..', '..', '..', '..', 'app.json');

describe('resolveAppBuild', () => {
  it('pins the fallback to the version app.json ships', () => {
    const appJson = JSON.parse(fs.readFileSync(APP_JSON, 'utf-8')) as {
      expo: { version: string };
    };
    expect(APP_BUILD_FALLBACK).toBe(appJson.expo.version);
    expect(BUILD_PATTERN.test(APP_BUILD_FALLBACK)).toBe(true);
  });

  it('uses a configured release that already fits the server', () => {
    expect(resolveAppBuild('1.4.2+318')).toBe('1.4.2+318');
    expect(resolveAppBuild('2026.09.17-beta')).toBe('2026.09.17-beta');
  });

  it('accepts a release exactly at the length bound and rejects one past it', () => {
    const atBound = 'a'.repeat(FEEDBACK_BUILD_MAX_LENGTH);
    expect(resolveAppBuild(atBound)).toBe(atBound);
    expect(resolveAppBuild(`${atBound}1`)).toBe(APP_BUILD_FALLBACK);
  });

  it.each([['adepthood@1.4.2'], ['-leading-dash'], [''], ['with space']])(
    'falls back rather than mangling %p',
    (release) => {
      expect(resolveAppBuild(release)).toBe(APP_BUILD_FALLBACK);
    },
  );

  it('falls back when nothing is configured', () => {
    expect(resolveAppBuild(undefined)).toBe(APP_BUILD_FALLBACK);
  });

  it('reads EXPO_PUBLIC_SENTRY_RELEASE by default', () => {
    const previous = process.env.EXPO_PUBLIC_SENTRY_RELEASE;
    process.env.EXPO_PUBLIC_SENTRY_RELEASE = '9.9.9';
    try {
      expect(resolveAppBuild()).toBe('9.9.9');
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_SENTRY_RELEASE;
      else process.env.EXPO_PUBLIC_SENTRY_RELEASE = previous;
    }
  });
});

describe('parseControlToken', () => {
  it('accepts every declared token', () => {
    for (const token of Object.values(FEEDBACK_CONTROL_TOKENS)) {
      expect(parseControlToken(token)).toBe(token);
    }
  });

  it.each([
    // Matches CONTROL_PATTERN but is not a declared control: a word-bearing token.
    ['my_private_note'],
    ['journal.entry.body'],
    ['my resonance prose'],
    ['https://example.com/?q=1'],
    ["TypeError: Cannot read properties of undefined (reading 'x')"],
    [''],
    [42],
    [null],
    [undefined],
    [{ control: 'shell.header.send_feedback' }],
    ['shell.header.send_feedback'.padEnd(65, 'x')],
  ])('drops %p', (raw) => {
    expect(parseControlToken(raw)).toBeUndefined();
  });
});
