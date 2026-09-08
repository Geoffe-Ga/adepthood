/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * ``CorpusInvitationNote`` on its own: when it asks the server, and what it
 * does with the answer. It asks nothing at zero passes, once per increment,
 * and never sets state after unmounting.
 */
import type { CorpusInvitation } from '@/api';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';
import {
  CORPUS_CONSENT_COPY_ENTRIES,
  CORPUS_INVITATION_REACH,
} from '@/features/Settings/corpusConsentCopy';

const mockStatus = jest.fn() as jest.MockedFunction<() => Promise<CorpusInvitation>>;
const mockDismiss = jest.fn() as jest.MockedFunction<
  (_never: boolean) => Promise<CorpusInvitation>
>;

jest.mock('@/api', () => ({
  corpusInvitation: {
    status: (...a: unknown[]) => (mockStatus as unknown as (...x: unknown[]) => unknown)(...a),
    dismiss: (...a: unknown[]) => (mockDismiss as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

const CorpusInvitationNote = require('../CorpusInvitationNote').default;

const INVITATION = 'journal-corpus-invitation';
const OFFERED: CorpusInvitation = { offer: true, dismissed_at: null, do_not_ask_again: false };
const SILENT: CorpusInvitation = { offer: false, dismissed_at: null, do_not_ask_again: false };

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

function renderNote(completedPasses: number, onOpen = jest.fn()) {
  const Note = CorpusInvitationNote as unknown as React.ComponentType<{
    completedPasses: number;
    onOpen: () => void;
  }>;
  return { ...render(<Note completedPasses={completedPasses} onOpen={onOpen} />), onOpen };
}

beforeEach(() => {
  mockStatus.mockReset();
  mockDismiss.mockReset();
  mockStatus.mockResolvedValue(OFFERED);
  mockDismiss.mockResolvedValue(SILENT);
});

describe('CorpusInvitationNote', () => {
  it('asks the server nothing before a pass has completed', async () => {
    const { queryByTestId } = renderNote(0);

    await act(async () => {});

    expect(mockStatus).not.toHaveBeenCalled();
    expect(queryByTestId(INVITATION)).toBeNull();
  });

  it('asks once per completed pass and renders on offer:true', async () => {
    const Note = CorpusInvitationNote as unknown as React.ComponentType<{
      completedPasses: number;
      onOpen: () => void;
    }>;
    const view = render(<Note completedPasses={1} onOpen={jest.fn()} />);

    await view.findByTestId(INVITATION);
    expect(mockStatus).toHaveBeenCalledTimes(1);

    view.rerender(<Note completedPasses={2} onOpen={jest.fn()} />);
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
  });

  it('renders every line from the consent vocabulary, none of it ranking or shaming', async () => {
    const view = renderNote(1);
    const root = (await view.findByTestId(INVITATION)) as unknown as RenderedNode;

    const rendered = collectRenderedStrings(root);
    expect(rendered.some((line) => line.includes(CORPUS_INVITATION_REACH))).toBe(true);
    for (const line of rendered) {
      expect(ranksOrShames(line)).toBe(false);
    }
    // No digit anywhere: the pass count stays on the server and nothing here is a meter.
    expect(rendered.join(' ')).not.toMatch(/\d/);
    // Every fixed line is one the copy sweep already reads.
    const swept = CORPUS_CONSENT_COPY_ENTRIES.join('\n');
    for (const line of rendered.filter((text) => text.length > 0)) {
      expect(swept).toContain(line);
    }
  });

  it('stays silent when the client throws synchronously', async () => {
    // Nine older screen specs mock `@/api` without `corpusInvitation` at all, so
    // the call is a TypeError before any promise exists. Only an `await`
    // inside a try/catch turns that into silence; a `.catch` on the call
    // would never see it.
    mockStatus.mockImplementation(() => {
      throw new TypeError('corpusInvitation is undefined');
    });
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { queryByTestId } = renderNote(1);
      await act(async () => {});
      expect(mockStatus).toHaveBeenCalledTimes(1);
      expect(queryByTestId(INVITATION)).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('sets no state after unmounting while the read is in flight', async () => {
    let resolve: (value: CorpusInvitation) => void = () => {};
    mockStatus.mockReturnValue(
      new Promise<CorpusInvitation>((r) => {
        resolve = r;
      }),
    );
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { unmount } = renderNote(1);
      unmount();
      await act(async () => {
        resolve(OFFERED);
      });
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('opening calls back, spends the offer, and hides the note', async () => {
    const { findByTestId, getByTestId, queryByTestId, onOpen } = renderNote(1);
    await findByTestId(INVITATION);

    fireEvent.press(getByTestId(`${INVITATION}-open`));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(mockDismiss).toHaveBeenCalledWith(false);
    expect(queryByTestId(INVITATION)).toBeNull();
  });

  it('a failed decline write still leaves the note hidden and throws nothing', async () => {
    mockDismiss.mockRejectedValue(new Error('offline'));
    const { findByTestId, getByTestId, queryByTestId } = renderNote(1);
    await findByTestId(INVITATION);

    fireEvent.press(getByTestId(`${INVITATION}-never`));
    await act(async () => {});

    expect(mockDismiss).toHaveBeenCalledWith(true);
    expect(queryByTestId(INVITATION)).toBeNull();
  });
});
