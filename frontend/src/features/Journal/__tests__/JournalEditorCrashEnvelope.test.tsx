/**
 * C12 (#3160): a render crash inside the Journal editor, while it holds an
 * Intimate entry's words, ships a crash envelope carrying none of them.
 *
 * The scrubber's own tests (`observability/__tests__/sentryEnvelope.test.ts`)
 * hand `buildEvent` an error directly. This one takes the path a real crash
 * takes: the editor is open on an Intimate draft whose title and body are
 * canaries, the body field throws while rendering with an error whose message
 * quotes what the writer typed, the Journal tab's `FeatureErrorBoundary`
 * catches it, and `reportException` posts the envelope through `fetch` -- the
 * bytes asserted are the bytes a configured build would put on the wire.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { JournalMessage } from '@/api';
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary';
import { initErrorMonitoring } from '@/observability/sentry';
import { MESSAGE_WITHHELD } from '@/observability/sentryEnvelope';

const DSN_ENV = 'EXPO_PUBLIC_SENTRY_DSN';
const DSN = 'https://examplepublickey@o0.ingest.sentry.io/42';

// Synthetic stand-ins for what the writer put in an Intimate entry.
// Not secrets: detect-secrets reads their entropy, hence the pragmas.
const BODY_CANARY = 'SYNTHETIC_JOURNAL_CANARY_20261005_BODY_editor'; // pragma: allowlist secret
const TITLE_CANARY = 'SYNTHETIC_JOURNAL_CANARY_20261005_TITLE_editor'; // pragma: allowlist secret
const TYPED_CANARY = 'SYNTHETIC_JOURNAL_CANARY_20261005_TYPED_editor'; // pragma: allowlist secret

/** The boundary name the Journal tab is wrapped in (`navigation/BottomTabs.tsx`). */
const JOURNAL_BOUNDARY = 'Journal';

/** Flips the editor's body field from rendering to throwing. */
const mockCrash = { armed: false };

jest.mock('../LiveMarkdownBody', () => {
  const actual = jest.requireActual('../LiveMarkdownBody') as {
    default: React.ComponentType<{ body: string }>;
  };
  const mockReact = jest.requireActual('react') as typeof React;
  // The message quotes the body: the worst a throw site can do.
  function LiveMarkdownBody(props: { body: string }) {
    if (mockCrash.armed) {
      throw new Error(`could not lay out the page: ${props.body}`);
    }
    return mockReact.createElement(actual.default, props);
  }
  return { ...actual, __esModule: true, default: LiveMarkdownBody };
});

// The boundary subscribes to tab focus; no navigator is mounted here.
jest.mock('@react-navigation/native', () => ({
  ...(jest.requireActual('@react-navigation/native') as Record<string, unknown>),
  useNavigation: () => ({ addListener: () => () => undefined }),
}));

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;

jest.mock('@/api', () => ({
  ...require('./journalUiFlagsTestKit'),
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(),
    update: jest.fn(() => new Promise(() => undefined)),
  },
  prompts: { respond: jest.fn() },
  resonance: { list: jest.fn(() => Promise.resolve({ items: [] })), generate: jest.fn() },
  completionSuggestions: {
    list: jest.fn(() => Promise.resolve({ items: [] })),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    list: jest.fn(() => Promise.resolve([])),
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: jest.fn(),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

function intimateDraft(): JournalMessage {
  return {
    id: 7,
    message: `${BODY_CANARY} I sat with the river and did not look away.`,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: TITLE_CANARY,
    status: 'draft',
    classification: 'intimate',
    updated_at: '2026-06-01T00:00:00Z',
  } as JournalMessage;
}

function renderEditor() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(
    <FeatureErrorBoundary name={JOURNAL_BOUNDARY}>
      <Screen navigation={navigation} route={route} />
    </FeatureErrorBoundary>,
  );
}

let sent: string[];
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let quiet: Array<ReturnType<typeof jest.spyOn>>;

beforeEach(() => {
  mockCrash.armed = false;
  mockGet.mockReset();
  mockGet.mockResolvedValue(intimateDraft());
  sent = [];
  quiet = (['error', 'info', 'warn'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => undefined),
  );
  Object.defineProperty(globalThis, 'fetch', {
    value: jest.fn((_url: string, init: { body: string }) => {
      sent.push(init.body);
      return Promise.resolve({ ok: true });
    }),
    configurable: true,
    writable: true,
  });
  process.env = { ...originalEnv, [DSN_ENV]: DSN };
  expect(initErrorMonitoring()).toBe(true);
});

afterEach(() => {
  process.env = { ...originalEnv };
  delete process.env[DSN_ENV];
  // Leave the reporter inert so no later test can post anywhere.
  initErrorMonitoring();
  Object.defineProperty(globalThis, 'fetch', {
    value: originalFetch,
    configurable: true,
    writable: true,
  });
  quiet.forEach((spy) => spy.mockRestore());
});

/** The event item of the one envelope the crash posted. */
function onlyEvent(): Record<string, unknown> {
  expect(sent).toHaveLength(1);
  const [, , payload] = (sent[0] ?? '').split('\n');
  return JSON.parse(payload ?? '{}') as Record<string, unknown>;
}

/** Each canary's raw and JSON-escaped forms: either one present is a leak. */
function leaks(blob: string): string[] {
  return [BODY_CANARY, TITLE_CANARY, TYPED_CANARY, 'SYNTHETIC_JOURNAL_CANARY']
    .flatMap((canary) => [canary, JSON.stringify(canary).slice(1, -1)])
    .filter((fragment) => blob.includes(fragment));
}

describe('Journal editor crash envelope (C12)', () => {
  it('ships an envelope with no Intimate canary when the editor crashes mid-edit', async () => {
    const screen = renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('journal-body-input').props.value).toContain(BODY_CANARY);
    });
    expect(screen.getByTestId('journal-title-input').props.value).toBe(TITLE_CANARY);
    expect(sent).toHaveLength(0);

    mockCrash.armed = true;
    await act(async () => {
      fireEvent.changeText(
        screen.getByTestId('journal-body-input'),
        `${BODY_CANARY} ${TYPED_CANARY} and then the page broke.`,
      );
      await Promise.resolve();
    });

    const event = onlyEvent();
    expect(leaks(sent[0] ?? '')).toEqual([]);
    // Positive control: the operator still learns what failed, and where.
    expect(event.level).toBe('error');
    expect(event.exception).toEqual({ values: [{ type: 'Error', value: MESSAGE_WITHHELD }] });
    // A real editor crash identifies its fixed boundary without exporting
    // component/display names, which can themselves contain private text.
    expect(event.contexts).toEqual({
      errorBoundary: {
        boundary: 'FeatureErrorBoundary',
        name: JOURNAL_BOUNDARY,
      },
    });
    expect(event.contexts).not.toHaveProperty('react');
  });

  it('posts nothing while the editor holds the same words without crashing (control)', async () => {
    const screen = renderEditor();
    await waitFor(() => {
      expect(screen.getByTestId('journal-body-input').props.value).toContain(BODY_CANARY);
    });

    await act(async () => {
      fireEvent.changeText(screen.getByTestId('journal-body-input'), `${BODY_CANARY} more.`);
      await Promise.resolve();
    });

    expect(sent).toEqual([]);
  });
});
