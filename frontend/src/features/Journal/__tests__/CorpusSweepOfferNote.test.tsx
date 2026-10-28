/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * ``CorpusSweepOfferNote`` on its own (#3500): when it asks, what it does with
 * the answer, the two one-tap declines, and that its affirmative only
 * navigates -- it never starts a sweep in place.
 */
import type { CorpusConsent, CorpusSweepEstimate } from '@/api';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import { CORPUS_CONSENT_GAIN } from '@/features/Settings/corpusConsentCopy';
import {
  CORPUS_SWEEP_COPY_ENTRIES,
  corpusSweepPendingLine,
} from '@/features/Settings/corpusSweepCopy';
import { CORPUS_SWEEP_OFFER_NEVER_KEY } from '@/storage/corpusSweepOfferStorage';
import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';

const mockList = jest.fn() as jest.MockedFunction<() => Promise<CorpusConsent[]>>;
const mockEstimate = jest.fn() as jest.MockedFunction<() => Promise<CorpusSweepEstimate>>;
const mockSweep = jest.fn() as jest.MockedFunction<() => Promise<unknown>>;

jest.mock('@/api', () => ({
  corpusConsent: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
  },
  corpus: {
    sweepEstimate: (...a: unknown[]) =>
      (mockEstimate as unknown as (...x: unknown[]) => unknown)(...a),
    sweep: (...a: unknown[]) => (mockSweep as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

const CorpusSweepOfferNote = require('../CorpusSweepOfferNote').default;

const OFFER = 'journal-corpus-sweep-offer';
const PENDING = 412;

type NoteProps = { completedPasses: number; onOpen: () => void; suppressed?: boolean };
const Note = CorpusSweepOfferNote as unknown as React.ComponentType<NoteProps>;

function decision(source: string, granted: boolean): CorpusConsent {
  return { source, granted, decided_at: '2026-10-01T00:00:00Z' };
}

const GRANTED = [decision('journal', true), decision('upload', false)];
const NOT_GRANTED = [decision('journal', false), decision('upload', true)];

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
  for (const child of node.children ?? []) collected.push(...collectRenderedStrings(child));
  return collected;
}

function renderNote(completedPasses: number, props: Partial<NoteProps> = {}) {
  const onOpen = jest.fn();
  const view = render(<Note completedPasses={completedPasses} onOpen={onOpen} {...props} />);
  return { ...view, onOpen };
}

/** Let every read the note issued settle. */
async function settle(): Promise<void> {
  await act(async () => {});
}

beforeEach(async () => {
  mockList.mockReset();
  mockEstimate.mockReset();
  mockSweep.mockReset();
  mockList.mockResolvedValue(GRANTED);
  mockEstimate.mockResolvedValue({ entries_pending: PENDING });
  await AsyncStorage.clear();
  setActiveUser(1);
  resetAllStores();
});

afterEach(() => {
  setActiveUser(null);
});

describe('CorpusSweepOfferNote', () => {
  it('asks nothing before a pass has completed', async () => {
    const { queryByTestId } = renderNote(0);

    await settle();

    expect(mockList).not.toHaveBeenCalled();
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(queryByTestId(OFFER)).toBeNull();
  });

  it('offers the backlog under a standing yes, saying how much is waiting', async () => {
    const view = renderNote(1);

    await view.findByTestId(OFFER);
    expect(view.getByText(CORPUS_CONSENT_GAIN)).toBeTruthy();
    expect(view.getByText(corpusSweepPendingLine(PENDING))).toBeTruthy();
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockEstimate).toHaveBeenCalledTimes(1);
  });

  it('asks again only when the pass count moves', async () => {
    mockEstimate.mockResolvedValue({ entries_pending: 0 });
    const view = renderNote(1);
    await settle();
    view.rerender(<Note completedPasses={1} onOpen={view.onOpen} />);
    await settle();
    expect(mockEstimate).toHaveBeenCalledTimes(1);

    view.rerender(<Note completedPasses={2} onOpen={view.onOpen} />);
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(2));
  });

  it('renders nothing at zero pending', async () => {
    mockEstimate.mockResolvedValue({ entries_pending: 0 });
    const { queryByTestId } = renderNote(1);

    await settle();

    expect(mockEstimate).toHaveBeenCalledTimes(1);
    expect(queryByTestId(OFFER)).toBeNull();
  });

  it('renders nothing, and reads no count, without a standing yes for the journal', async () => {
    mockList.mockResolvedValue(NOT_GRANTED);
    const { queryByTestId } = renderNote(1);

    await settle();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockEstimate).not.toHaveBeenCalled();
    expect(queryByTestId(OFFER)).toBeNull();
  });

  it('renders nothing when the consent read fails', async () => {
    mockList.mockRejectedValue(new Error('offline'));
    const { queryByTestId } = renderNote(1);

    await settle();

    expect(queryByTestId(OFFER)).toBeNull();
  });

  it('renders nothing when the count read fails', async () => {
    mockEstimate.mockRejectedValue(new Error('offline'));
    const { queryByTestId } = renderNote(1);

    await settle();

    expect(mockEstimate).toHaveBeenCalledTimes(1);
    expect(queryByTestId(OFFER)).toBeNull();
  });

  it('stays silent when the client throws synchronously', async () => {
    mockList.mockImplementation(() => {
      throw new TypeError('corpusConsent is undefined');
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { queryByTestId } = renderNote(1);
      await settle();
      expect(queryByTestId(OFFER)).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('renders nothing while the consent invitation is showing, and appears once it goes', async () => {
    const view = renderNote(1, { suppressed: true });
    await settle();
    expect(view.queryByTestId(OFFER)).toBeNull();

    view.rerender(<Note completedPasses={1} onOpen={view.onOpen} suppressed={false} />);

    expect(view.getByTestId(OFFER)).toBeTruthy();
  });

  it('the affirmative navigates and never calls the sweep', async () => {
    const view = renderNote(1);
    await view.findByTestId(OFFER);

    fireEvent.press(view.getByTestId(`${OFFER}-open`));
    await settle();

    expect(view.onOpen).toHaveBeenCalledTimes(1);
    expect(mockSweep).not.toHaveBeenCalled();
    expect(view.queryByTestId(OFFER)).toBeNull();
  });

  it('"Not now" removes it, and it does not come back on a later pass this session', async () => {
    const view = renderNote(1);
    await view.findByTestId(OFFER);

    fireEvent.press(view.getByTestId(`${OFFER}-dismiss`));
    expect(view.queryByTestId(OFFER)).toBeNull();

    view.rerender(<Note completedPasses={2} onOpen={view.onOpen} />);
    await settle();
    expect(view.queryByTestId(OFFER)).toBeNull();
    expect(mockEstimate).toHaveBeenCalledTimes(1);

    // Another page opened in the same session is not asked either.
    view.unmount();
    const next = renderNote(3);
    await settle();
    expect(next.queryByTestId(OFFER)).toBeNull();
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('"Do not ask again" removes it and is remembered for the account', async () => {
    const view = renderNote(1);
    await view.findByTestId(OFFER);

    fireEvent.press(view.getByTestId(`${OFFER}-never`));
    expect(view.queryByTestId(OFFER)).toBeNull();
    await settle();
    expect(await AsyncStorage.getItem(`${CORPUS_SWEEP_OFFER_NEVER_KEY}#u1`)).toBe('true');

    // A later session (stores reset) still is not asked.
    view.unmount();
    resetAllStores();
    const next = renderNote(1);
    await settle();
    expect(next.queryByTestId(OFFER)).toBeNull();
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('a read still in flight cannot resurrect the note after a decline', async () => {
    let answerSecondRead: (value: CorpusSweepEstimate) => void = () => {};
    mockEstimate.mockResolvedValueOnce({ entries_pending: PENDING }).mockReturnValueOnce(
      new Promise<CorpusSweepEstimate>((resolve) => {
        answerSecondRead = resolve;
      }),
    );
    const view = renderNote(1);
    await view.findByTestId(OFFER);

    view.rerender(<Note completedPasses={2} onOpen={view.onOpen} />);
    await waitFor(() => expect(mockEstimate).toHaveBeenCalledTimes(2));
    expect(view.queryByTestId(OFFER)).not.toBeNull();

    fireEvent.press(view.getByTestId(`${OFFER}-never`));
    expect(view.queryByTestId(OFFER)).toBeNull();

    await act(async () => {
      answerSecondRead({ entries_pending: PENDING });
    });

    expect(view.queryByTestId(OFFER)).toBeNull();
  });

  it('sets no state after unmounting while a read is in flight', async () => {
    let resolve: (value: CorpusConsent[]) => void = () => {};
    mockList.mockReturnValue(
      new Promise<CorpusConsent[]>((r) => {
        resolve = r;
      }),
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = renderNote(1);
      unmount();
      await act(async () => {
        resolve(GRANTED);
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('renders only swept copy, with no price or money language', async () => {
    const view = renderNote(1);
    const root = (await view.findByTestId(OFFER)) as unknown as RenderedNode;

    const rendered = collectRenderedStrings(root).filter((text) => text.length > 0);
    const swept = [...CORPUS_SWEEP_COPY_ENTRIES, CORPUS_CONSENT_GAIN].join('\n');
    for (const line of rendered) {
      expect(ranksOrShames(line)).toBe(false);
      expect(line).not.toMatch(/credit|token|price|cost|charge|pay|\$/i);
      if (line !== corpusSweepPendingLine(PENDING)) expect(swept).toContain(line);
    }
  });
});
