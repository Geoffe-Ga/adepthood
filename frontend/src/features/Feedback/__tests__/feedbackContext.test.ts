/* eslint-env jest */
/* global describe, it, expect, afterEach */
import { pyFrozenset, pyString } from './pythonSource';

import { breakpoints } from '@/design/tokens';
import {
  buildFeedbackContext,
  narrowLocale,
  platformFor,
  resolveDeviceLocale,
  resolveOriginRouteName,
  SCREEN_TOKEN_BY_ROUTE,
  UNKNOWN_SCREEN_TOKEN,
  viewportClassFor,
  VIEWPORT_EXPANDED_MIN_WIDTH,
  VIEWPORT_REGULAR_MIN_WIDTH,
} from '@/features/Feedback/feedbackContext';
import { readBackendSource } from '@/testing/backendSource';

const schemaSource = readBackendSource('src', 'schemas', 'feedback.py');
const ALLOWED_CONTEXT_KEYS = pyFrozenset(schemaSource, 'ALLOWED_CONTEXT_KEYS');
const SCREEN_PATTERN = new RegExp(pyString(schemaSource, 'SCREEN_PATTERN'));

const PRIVATE_PROSE = 'my private journal prose';

/** The stack a user is on when the composer is open over the Journal tab. */
const stackOverJournal = {
  index: 1,
  routes: [
    {
      name: 'Tabs',
      state: {
        index: 0,
        routes: [{ name: 'Journal', params: { entryId: 42, text: PRIVATE_PROSE } }],
      },
    },
    { name: 'Feedback', params: { control: 'shell.header.send_feedback' } },
  ],
};

const baseInput = {
  routeName: 'Journal',
  control: 'shell.header.send_feedback',
  width: 390,
  os: 'ios',
  locale: 'en-US',
  appBuild: '1.0.0',
} as const;

describe('buildFeedbackContext', () => {
  it('emits only keys the server allowlists, with a screen token the server accepts', () => {
    expect(ALLOWED_CONTEXT_KEYS).toHaveLength(7);

    const context = buildFeedbackContext(baseInput);

    for (const key of Object.keys(context)) {
      expect(ALLOWED_CONTEXT_KEYS).toContain(key);
    }
    expect(context.screen).toBe('journal.shelf');
    expect(SCREEN_PATTERN.test(context.screen)).toBe(true);
    expect(context.platform).toBe('ios');
    expect(context.viewport_class).toBe('compact');
    expect(context.locale).toBe('en-US');
    expect(context.control).toBe('shell.header.send_feedback');
    expect(context.app_build).toBe('1.0.0');
    // D1: omitted, not generated -- see the block comment in feedbackContext.ts.
    expect(Object.keys(context)).not.toContain('correlation_id');
  });

  it('assembles exactly the named keys, so no stray input field rides along', () => {
    const context = buildFeedbackContext({
      ...baseInput,
      // Not part of the input type: proves an extra field on the argument is dropped.
      ...({ text: PRIVATE_PROSE, params: { entryId: 42 } } as object),
    });

    expect(Object.keys(context).sort()).toEqual(
      ['app_build', 'control', 'locale', 'platform', 'screen', 'viewport_class'].sort(),
    );
    expect(JSON.stringify(context)).not.toContain(PRIVATE_PROSE);
    expect(JSON.stringify(context)).not.toContain('entryId');
  });

  it('omits control and locale rather than sending them empty', () => {
    const context = buildFeedbackContext({ ...baseInput, control: undefined, locale: undefined });

    expect(Object.keys(context)).not.toContain('control');
    expect(Object.keys(context)).not.toContain('locale');
  });

  it('narrows the locale before it is attached', () => {
    expect(buildFeedbackContext({ ...baseInput, locale: 'zh-Hant-TW' }).locale).toBe('zh-TW');
    expect(Object.keys(buildFeedbackContext({ ...baseInput, locale: 'english' }))).not.toContain(
      'locale',
    );
  });

  it('builds from the origin route resolved out of navigation state, never its params', () => {
    const routeName = resolveOriginRouteName(stackOverJournal);
    const context = buildFeedbackContext({ ...baseInput, routeName });

    expect(routeName).toBe('Journal');
    expect(JSON.stringify(context)).not.toContain(PRIVATE_PROSE);
    expect(JSON.stringify(context)).not.toContain('entryId');
  });
});

describe('screen tokens', () => {
  it('maps every known route to a token the server pattern accepts', () => {
    const tokens = Object.values(SCREEN_TOKEN_BY_ROUTE);
    expect(tokens.length).toBeGreaterThanOrEqual(6);
    for (const token of [...tokens, UNKNOWN_SCREEN_TOKEN]) {
      expect(SCREEN_PATTERN.test(token)).toBe(true);
    }
  });

  it('covers all five tab destinations and Settings', () => {
    for (const route of ['Journal', 'Habits', 'Practice', 'Course', 'Map', 'Settings']) {
      expect(SCREEN_TOKEN_BY_ROUTE[route]).toBeDefined();
    }
  });

  it('falls back to the named unknown token for an unmapped or missing route', () => {
    expect(buildFeedbackContext({ ...baseInput, routeName: 'SomethingNew' }).screen).toBe(
      UNKNOWN_SCREEN_TOKEN,
    );
    expect(buildFeedbackContext({ ...baseInput, routeName: undefined }).screen).toBe(
      UNKNOWN_SCREEN_TOKEN,
    );
    // An inherited Object property is not a route.
    expect(buildFeedbackContext({ ...baseInput, routeName: 'toString' }).screen).toBe(
      UNKNOWN_SCREEN_TOKEN,
    );
  });
});

describe('resolveOriginRouteName', () => {
  it('descends into the focused tab and returns only its name', () => {
    expect(resolveOriginRouteName(stackOverJournal)).toBe('Journal');
  });

  it('reads the focused tab, not the first one', () => {
    const state = {
      index: 1,
      routes: [
        {
          name: 'Tabs',
          state: { index: 2, routes: [{ name: 'Journal' }, { name: 'Habits' }, { name: 'Map' }] },
        },
        { name: 'Feedback' },
      ],
    };
    expect(resolveOriginRouteName(state)).toBe('Map');
  });

  it('returns a stack route below the composer, such as Settings', () => {
    const state = {
      index: 2,
      routes: [
        { name: 'Tabs' },
        { name: 'Settings', params: { note: PRIVATE_PROSE } },
        { name: 'Feedback' },
      ],
    };
    expect(resolveOriginRouteName(state)).toBe('Settings');
  });

  it('treats a tab shell with no committed child state as its initial Journal tab', () => {
    const state = { index: 1, routes: [{ name: 'Tabs' }, { name: 'Feedback' }] };
    expect(resolveOriginRouteName(state)).toBe('Journal');
  });

  it('returns undefined when there is nothing below the composer', () => {
    expect(resolveOriginRouteName({ index: 0, routes: [{ name: 'Feedback' }] })).toBeUndefined();
    expect(resolveOriginRouteName(undefined)).toBeUndefined();
    expect(resolveOriginRouteName({ index: 0, routes: [] })).toBeUndefined();
  });

  it('uses the top of the stack when the composer is not on it', () => {
    const state = { index: 1, routes: [{ name: 'Tabs' }, { name: 'Settings' }] };
    expect(resolveOriginRouteName(state)).toBe('Settings');
  });
});

describe('platformFor', () => {
  it.each([
    ['android', 'android'],
    ['ios', 'ios'],
    ['web', 'web'],
    ['windows', 'web'],
    ['macos', 'web'],
  ])('maps %s to %s', (os, expected) => {
    expect(platformFor(os)).toBe(expected);
  });
});

describe('viewportClassFor', () => {
  it('builds its thresholds from the design breakpoints', () => {
    expect(VIEWPORT_REGULAR_MIN_WIDTH).toBe(breakpoints.md);
    expect(VIEWPORT_EXPANDED_MIN_WIDTH).toBe(breakpoints.lg);
  });

  it.each([
    [390, 'compact'],
    [599, 'compact'],
    [600, 'regular'],
    [899, 'regular'],
    [900, 'expanded'],
    [1280, 'expanded'],
  ])('classes %ipx as %s', (width, expected) => {
    expect(viewportClassFor(width)).toBe(expected);
  });
});

describe('narrowLocale', () => {
  it.each([
    ['en-US', 'en-US'],
    ['en', 'en'],
    ['zh-Hant-TW', 'zh-TW'],
    ['en_US', 'en-US'],
    ['EN-us', 'en-US'],
    ['es-419', 'es'],
    ['fil-PH', 'fil-PH'],
  ])('narrows %s to %s', (raw, expected) => {
    expect(narrowLocale(raw)).toBe(expected);
  });

  it.each([['english'], [''], ['e'], ['12-US']])('drops %p', (raw) => {
    expect(narrowLocale(raw)).toBeUndefined();
  });

  it('drops an absent locale', () => {
    expect(narrowLocale(undefined)).toBeUndefined();
  });
});

describe('resolveDeviceLocale', () => {
  const realIntl = globalThis.Intl;

  afterEach(() => {
    globalThis.Intl = realIntl;
  });

  it('reads the runtime locale', () => {
    expect(resolveDeviceLocale()).toBe(new Intl.DateTimeFormat().resolvedOptions().locale);
  });

  it('returns undefined when Intl is unavailable', () => {
    // A runtime without Intl (some older Hermes builds) must not break the composer.
    Object.defineProperty(globalThis, 'Intl', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(resolveDeviceLocale()).toBeUndefined();
  });
});
