/* eslint-env jest */
/**
 * What the voice-readiness band must and must not do on the Journal shelf.
 *
 * Three of these are the reason the band exists in this shape. It is declinable
 * in one tap and stays declined. It renders no number, ever, though the payload
 * carries one. And its destination follows the *state* — the consent decision
 * for an account that has not made it, the import surface for one that has —
 * which is asserted with ``grounding_source`` flipped underneath, so a second
 * copy of the cause rule cannot quietly grow on the client.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { VoiceReadinessT } from '@/api/schemas';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

const mockReadiness = jest.fn() as jest.MockedFunction<() => Promise<VoiceReadinessT>>;
const mockLoadDismissed = jest.fn() as jest.MockedFunction<() => Promise<boolean>>;
const mockSaveDismissed = jest.fn() as jest.MockedFunction<(_v: boolean) => Promise<void>>;
const mockNavigate = jest.fn();

jest.mock('@/api', () => ({
  corpus: {
    voiceReadiness: (...a: unknown[]) =>
      (mockReadiness as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/storage/voiceReadinessDismissalStorage', () => ({
  loadVoiceReadinessDismissed: (...a: unknown[]) =>
    (mockLoadDismissed as unknown as (...x: unknown[]) => unknown)(...a),
  saveVoiceReadinessDismissed: (...a: unknown[]) =>
    (mockSaveDismissed as unknown as (...x: unknown[]) => unknown)(...a),
}));

// Only ``useNavigation`` is provided. The band must never reach for
// ``useFocusEffect`` — refetching on every tab return would be a poll wearing a
// different name — and calling it here would throw rather than pass quietly.
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const VoiceReadinessBand = require('../VoiceReadinessBand').default;

const BAND = 'journal-voice-readiness-band';
const DISMISS = 'journal-voice-readiness-dismiss';

const NOT_CONSENTED_COPY =
  'Right now your reflections are drawn from your last few days of writing. Sorting your ' +
  'journal into your own corpus is a separate decision, and it is yours to make whenever ' +
  'you like — say yes and everything you have already put down gets sorted too. Perfectly ' +
  'fine to leave as it is.';
const GATHERING_COPY =
  'Your corpus is still filling out, so your reflections are drawn from recent days for ' +
  'now. Bringing in work you did elsewhere fills it faster. Nothing is waiting on you.';

/** A readiness payload, defaulting to the state the great majority of accounts are in. */
function readiness(overrides: Partial<VoiceReadinessT> = {}): VoiceReadinessT {
  return {
    ready: false,
    state: 'not_consented',
    message: NOT_CONSENTED_COPY,
    grounding_source: 'recent_entries',
    classified_fragment_count: 0,
    ...overrides,
  };
}

type RenderedNode = {
  children?: (RenderedNode | string)[] | null;
  props?: { accessibilityLabel?: unknown };
};

/** Every string this subtree renders, including accessibility labels. */
function collectRenderedStrings(node: RenderedNode | string): string[] {
  if (typeof node === 'string') return [node];
  const collected: string[] = [];
  const label = node.props ? node.props.accessibilityLabel : undefined;
  if (typeof label === 'string') collected.push(label);
  for (const child of node.children ?? []) {
    collected.push(...collectRenderedStrings(child as RenderedNode | string));
  }
  return collected;
}

/** Let the mount effect's promise chain settle without asserting on anything. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockReadiness.mockReset();
  mockLoadDismissed.mockReset();
  mockSaveDismissed.mockReset();
  mockNavigate.mockReset();
  mockReadiness.mockResolvedValue(readiness());
  mockLoadDismissed.mockResolvedValue(false);
  mockSaveDismissed.mockResolvedValue(undefined);
});

describe('VoiceReadinessBand — when it stays quiet', () => {
  it('renders nothing while readiness is still resolving', () => {
    mockReadiness.mockReturnValue(new Promise(() => {}));
    const { queryByTestId } = render(<VoiceReadinessBand />);
    // Synchronous first paint: no flash of a band that may never be shown.
    expect(queryByTestId(BAND)).toBeNull();
  });

  it('renders nothing when the readiness read fails', async () => {
    mockReadiness.mockRejectedValue(new Error('offline'));
    const { queryByTestId } = render(<VoiceReadinessBand />);
    await settle();
    expect(queryByTestId(BAND)).toBeNull();
  });

  it('renders nothing once the corpus is grounding the voice', async () => {
    mockReadiness.mockResolvedValue(
      readiness({
        ready: true,
        state: 'ready',
        message: null,
        grounding_source: 'corpus',
        classified_fragment_count: 40,
      }),
    );
    const { queryByTestId } = render(<VoiceReadinessBand />);
    await settle();
    expect(queryByTestId(BAND)).toBeNull();
  });

  it('stays quiet if either readiness signal says the corpus has arrived', async () => {
    // The two agree by construction on the server. If they ever stopped
    // agreeing, the band must fail towards silence rather than towards nagging
    // somebody whose voice is already their own.
    mockReadiness.mockResolvedValue(
      readiness({ ready: false, state: 'ready', message: 'a sentence that should not appear' }),
    );
    const { queryByTestId } = render(<VoiceReadinessBand />);
    await settle();
    expect(queryByTestId(BAND)).toBeNull();
  });

  it('renders nothing when a not-ready state arrives with no sentence', async () => {
    mockReadiness.mockResolvedValue(readiness({ message: null }));
    const { queryByTestId } = render(<VoiceReadinessBand />);
    await settle();
    expect(queryByTestId(BAND)).toBeNull();
  });

  it('renders nothing when the note was already set aside', async () => {
    mockLoadDismissed.mockResolvedValue(true);
    const { queryByTestId } = render(<VoiceReadinessBand />);
    await settle();
    expect(queryByTestId(BAND)).toBeNull();
    // And it did not even ask: a decline is a decline, not a snooze.
    expect(mockReadiness).not.toHaveBeenCalled();
  });
});

describe('VoiceReadinessBand — what it says', () => {
  it("renders the server's own sentence for an account that has not consented", async () => {
    const { findByTestId, getByText } = render(<VoiceReadinessBand />);
    await findByTestId(BAND);
    expect(getByText(NOT_CONSENTED_COPY)).toBeTruthy();
  });

  it('renders no count, ratio or progress, though the payload carries one', async () => {
    mockReadiness.mockResolvedValue(
      readiness({
        state: 'gathering',
        message: GATHERING_COPY,
        grounding_source: 'corpus',
        classified_fragment_count: 7,
      }),
    );
    const { findByTestId, toJSON } = render(<VoiceReadinessBand />);
    await findByTestId(BAND);

    const strings = collectRenderedStrings(toJSON() as unknown as RenderedNode);
    // Non-emptiness first: an empty render would satisfy every claim below
    // without testing any of them.
    expect(strings.length).toBeGreaterThan(0);
    expect(strings.join(' ')).toContain(GATHERING_COPY);
    expect(strings.join(' ')).not.toContain('7');
    for (const rendered of strings) {
      expect(rendered).not.toMatch(/\d/);
    }
  });

  it('never ranks, shames or pressures in its own chrome', async () => {
    const { findByTestId, toJSON } = render(<VoiceReadinessBand />);
    await findByTestId(BAND);

    const strings = collectRenderedStrings(toJSON() as unknown as RenderedNode);
    expect(strings.length).toBeGreaterThan(0);
    for (const rendered of strings) {
      expect(ranksOrShames(rendered)).toBe(false);
    }
  });
});

describe('VoiceReadinessBand — where it goes', () => {
  it('offers the consent decision to an account that has not made it', async () => {
    const { findByTestId } = render(<VoiceReadinessBand />);
    fireEvent.press(await findByTestId(BAND));
    expect(mockNavigate).toHaveBeenCalledWith('CorpusConsent');
  });

  it('offers the import surface to an account that is simply early', async () => {
    mockReadiness.mockResolvedValue(
      readiness({ state: 'gathering', message: GATHERING_COPY, grounding_source: 'corpus' }),
    );
    const { findByTestId } = render(<VoiceReadinessBand />);
    fireEvent.press(await findByTestId(BAND));
    expect(mockNavigate).toHaveBeenCalledWith('SeedCorpus');
  });

  it('routes on the state alone, whatever the reported grounding source says', async () => {
    // ``grounding_source`` is reporting, not the rule. If the client had grown
    // its own copy of the cause rule off this field, flipping it here while
    // holding the state would send the person to the wrong screen.
    mockReadiness.mockResolvedValue(readiness({ grounding_source: 'corpus' }));
    const { findByTestId } = render(<VoiceReadinessBand />);
    fireEvent.press(await findByTestId(BAND));
    expect(mockNavigate).toHaveBeenCalledWith('CorpusConsent');
  });
});

describe('VoiceReadinessBand — declining it', () => {
  it('retires on one tap and does not come back on a later visit', async () => {
    let stored = false;
    mockLoadDismissed.mockImplementation(() => Promise.resolve(stored));
    mockSaveDismissed.mockImplementation((value: boolean) => {
      stored = value;
      return Promise.resolve();
    });

    const first = render(<VoiceReadinessBand />);
    fireEvent.press(await first.findByTestId(DISMISS));
    await waitFor(() => {
      expect(first.queryByTestId(BAND)).toBeNull();
    });
    expect(mockSaveDismissed).toHaveBeenCalledWith(true);

    const second = render(<VoiceReadinessBand />);
    await settle();
    expect(second.queryByTestId(BAND)).toBeNull();
  });
});

describe('VoiceReadinessBand — how often it asks', () => {
  it('reads readiness exactly once per mount and never on a re-render', async () => {
    const { findByTestId, rerender } = render(<VoiceReadinessBand />);
    await findByTestId(BAND);

    rerender(<VoiceReadinessBand />);
    rerender(<VoiceReadinessBand />);
    await settle();

    // Once — not once per shelf page, and not on an interval. Readiness moves
    // on the scale of days.
    expect(mockReadiness).toHaveBeenCalledTimes(1);
    expect(mockReadiness).toHaveBeenCalledWith();
  });
});
