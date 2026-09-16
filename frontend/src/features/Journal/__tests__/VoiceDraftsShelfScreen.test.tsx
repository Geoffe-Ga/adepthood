/* eslint-env jest */
/* global jest */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

/**
 * ``VoiceDraftsShelfScreen`` (#2608) — the shelf that finally reaches
 * ``GET /journal/voice-drafts``.
 *
 * Two contracts are load-bearing here and neither is visible from the client
 * tests. The first is that the shelf is *retrieval*: the endpoint hands back a
 * ``total``, so a badge or a "you have N letters" line is one line of code
 * away, and NORTH-STAR §3/§6 forbid it — a shelf someone chooses to open is not
 * an invitation, and a count on the way in would make it one. The second is
 * that a letter's page is reachable from the letter, because a draft that can
 * only be admired is not the same thing as a body of work you can walk back
 * into.
 */

const mockNavigate = jest.fn();
const mockList = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/api', () => ({
  voiceDrafts: { list: (...args: unknown[]) => mockList(...args) },
}));

import VoiceDraftsShelfScreen from '../VoiceDraftsShelfScreen';

interface Draft {
  marginalia_id: number;
  journal_entry_id: number;
  kind: string;
  anchor_text: string;
  essay: string;
  essay_generated_at: string;
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    marginalia_id: 4,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_text: 'I walk the same river twice',
    essay: 'A letter about returning to the same water.',
    essay_generated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function page(items: Draft[], hasMore = false) {
  return { items, total: items.length, has_more: hasMore };
}

/** Every string the rendered tree shows a reader, flattened out of the JSON tree. */
function renderedText(tree: ReturnType<typeof render>): string {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node !== null && typeof node === 'object') {
      const element = node as { children?: unknown; props?: { accessibilityLabel?: unknown } };
      // Rendered copy and the labels a screen reader speaks -- the two surfaces
      // a reader actually meets. testIDs are deliberately not read: they are
      // developer vocabulary and carry digits of their own.
      const label = element.props?.accessibilityLabel;
      if (typeof label === 'string') found.push(label);
      walk(element.children);
    }
  };
  walk(tree.toJSON());
  return found.join(' | ');
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockList.mockReset();
});

describe('the Voice Drafts shelf', () => {
  it('reads the first page on arrival and lists each letter by the words it grew from', async () => {
    mockList.mockResolvedValueOnce(
      page([draft(), draft({ marginalia_id: 5, anchor_text: 'the far bank' })]),
    );

    const screen = render(<VoiceDraftsShelfScreen />);

    await waitFor(() => expect(screen.getByTestId('voice-draft-4')).toBeTruthy());
    expect(screen.getByTestId('voice-draft-5')).toBeTruthy();
    expect(screen.getByText(/I walk the same river twice/)).toBeTruthy();
    expect(mockList).toHaveBeenCalledWith({ offset: 0 });
  });

  it('greets an empty shelf with a first-run state rather than an error', async () => {
    mockList.mockResolvedValueOnce(page([]));

    const screen = render(<VoiceDraftsShelfScreen />);

    await waitFor(() => expect(screen.getByTestId('voice-drafts-empty')).toBeTruthy());
    expect(screen.queryByTestId('voice-drafts-error')).toBeNull();
  });

  it('shows the failure and lets the reader ask again', async () => {
    mockList.mockRejectedValueOnce(new Error('offline'));
    mockList.mockResolvedValueOnce(page([draft()]));

    const screen = render(<VoiceDraftsShelfScreen />);

    await waitFor(() => expect(screen.getByTestId('voice-drafts-error')).toBeTruthy());
    fireEvent.press(screen.getByTestId('voice-drafts-retry'));

    await waitFor(() => expect(screen.getByTestId('voice-draft-4')).toBeTruthy());
    expect(screen.queryByTestId('voice-drafts-error')).toBeNull();
  });

  it('appends the next page from where the last one ended', async () => {
    mockList.mockResolvedValueOnce(page([draft()], true));
    mockList.mockResolvedValueOnce(page([draft({ marginalia_id: 9, anchor_text: 'later still' })]));

    const screen = render(<VoiceDraftsShelfScreen />);

    await waitFor(() => expect(screen.getByTestId('voice-drafts-load-more')).toBeTruthy());
    fireEvent.press(screen.getByTestId('voice-drafts-load-more'));

    await waitFor(() => expect(screen.getByTestId('voice-draft-9')).toBeTruthy());
    expect(mockList).toHaveBeenLastCalledWith({ offset: 1 });
    // The first page stays on the shelf; a page load is an append, not a swap.
    expect(screen.getByTestId('voice-draft-4')).toBeTruthy();
    // Nothing left to load, so the row retires rather than asking forever.
    await waitFor(() => expect(screen.queryByTestId('voice-drafts-load-more')).toBeNull());
  });

  it('opens the letter itself, already in hand, without asking the server again', async () => {
    mockList.mockResolvedValueOnce(page([draft()]));

    const screen = render(<VoiceDraftsShelfScreen />);
    await waitFor(() => expect(screen.getByTestId('voice-draft-4')).toBeTruthy());

    expect(screen.queryByTestId('voice-draft-letter')).toBeNull();
    fireEvent.press(screen.getByTestId('voice-draft-4'));

    expect(screen.getByTestId('voice-draft-letter')).toBeTruthy();
    // The whole letter, not the shelf row's taste of it.
    expect(screen.getByTestId('voice-draft-letter-text').props.children).toBe(
      'A letter about returning to the same water.',
    );
    // The listing already carried the essay; opening one must not cost a request.
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('walks back from the letter to the page it was written in the margin of', async () => {
    mockList.mockResolvedValueOnce(page([draft()]));

    const screen = render(<VoiceDraftsShelfScreen />);
    await waitFor(() => expect(screen.getByTestId('voice-draft-4')).toBeTruthy());
    fireEvent.press(screen.getByTestId('voice-draft-4'));
    fireEvent.press(screen.getByTestId('voice-draft-open-page'));

    expect(mockNavigate).toHaveBeenCalledWith('JournalEntry', { entryId: 7 });
    // Leaving closes the letter, so returning to the shelf does not land on it.
    expect(screen.queryByTestId('voice-draft-letter')).toBeNull();
  });

  it('never counts the letters at the reader, however many the server reports', async () => {
    // Digit-free anchors and a June-1 date so the only numbers the tree could
    // show are ones the screen chose to write.
    const anchors = ['the near bank', 'the far bank', 'the ford'];
    const many = anchors.map((anchor_text, index) =>
      draft({ marginalia_id: index + 1, anchor_text }),
    );
    mockList.mockResolvedValueOnce({ items: many, total: 47, has_more: true });

    const screen = render(<VoiceDraftsShelfScreen />);
    await waitFor(() => expect(screen.getByTestId('voice-draft-1')).toBeTruthy());

    // The number the server volunteers is exactly the raw material of a nudge,
    // so no surface may spend it: not a badge, not a heading, not a subtitle.
    const text = renderedText(screen);
    expect(text).not.toMatch(/\b47\b/);
    // Nor the count of what is on screen, which is the same nudge cheaply made.
    expect(text).not.toMatch(/\b3\b/);
    expect(text.toLowerCase()).not.toMatch(/you have|unread|waiting for you|new draft/);
  });
});
