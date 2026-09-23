import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { DraftPanel, draftFilename } from '../components/DraftPanel';

import type { FeedbackIssueDraftT } from '@/api';

const mockDraft =
  jest.fn<(_id: string, _notes: number[], _token?: string) => Promise<FeedbackIssueDraftT>>();
const mockCopy = jest.fn<(_value: string) => Promise<boolean>>();
const mockSave = jest.fn<(_name: string, _contents: string, _type: string) => Promise<unknown>>();

jest.mock('@/api', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/api');
  return {
    ...actual,
    adminFeedback: {
      draft: (id: string, notes: number[], token?: string) => mockDraft(id, notes, token),
    },
  };
});
jest.mock('@/context/AuthContext', () => ({ useAuth: () => ({ token: 'operator-token' }) }));
jest.mock('@/utils/clipboard', () => ({ copyToClipboard: (value: string) => mockCopy(value) }));
jest.mock('@/features/Settings/saveDataExport', () => ({
  saveTextFile: (name: string, contents: string, type: string) => mockSave(name, contents, type),
}));

const NOTES = [
  { id: 7, body: 'Keep this one.', created_at: '2026-09-02T12:00:00+00:00' },
  { id: 8, body: 'Not this one.', created_at: '2026-09-02T12:05:00+00:00' },
];
const DRAFT: FeedbackIssueDraftT = {
  title: '[broken] The card vanished',
  markdown: '## Observed\n\nIt disappeared.\n',
  source_public_ids: ['FB-23456789'],
};

beforeEach(() => {
  mockDraft.mockReset();
  mockCopy.mockReset();
  mockSave.mockReset();
  mockDraft.mockResolvedValue(DRAFT);
  mockCopy.mockResolvedValue(true);
  mockSave.mockResolvedValue({ filename: 'x', uri: null, destination: 'browser-download' });
});

async function prepared(): Promise<ReturnType<typeof render>> {
  const screen = render(<DraftPanel publicId="FB-23456789" notes={NOTES} />);
  fireEvent.press(screen.getByTestId('draft-generate'));
  await waitFor(() => expect(screen.getByTestId('draft-preview')).toBeTruthy());
  return screen;
}

describe('DraftPanel', () => {
  it('quotes no note by default', async () => {
    await prepared();
    expect(mockDraft).toHaveBeenCalledWith('FB-23456789', [], 'operator-token');
  });

  it('sends only the notes that were ticked', async () => {
    const screen = render(<DraftPanel publicId="FB-23456789" notes={NOTES} />);
    fireEvent.press(screen.getByTestId('draft-note-7'));
    expect(screen.getByTestId('draft-note-7').props.accessibilityState).toMatchObject({
      checked: true,
    });
    fireEvent.press(screen.getByTestId('draft-generate'));
    await waitFor(() =>
      expect(mockDraft).toHaveBeenCalledWith('FB-23456789', [7], 'operator-token'),
    );
  });

  it('copies through the clipboard helper', async () => {
    const screen = await prepared();
    fireEvent.press(screen.getByTestId('draft-copy'));
    await waitFor(() => expect(mockCopy).toHaveBeenCalledTimes(1));
    expect(mockCopy.mock.calls[0]?.[0]).toContain(DRAFT.title);
    expect(mockCopy.mock.calls[0]?.[0]).toContain(DRAFT.markdown);
    await waitFor(() => expect(screen.getByText('Copied to the clipboard.')).toBeTruthy());
  });

  it('downloads through the shared text-file handoff', async () => {
    const screen = await prepared();
    fireEvent.press(screen.getByTestId('draft-download'));
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
    const [name, contents, type] = mockSave.mock.calls[0] ?? [];
    expect(name).toBe(draftFilename('FB-23456789'));
    expect(contents).toContain(DRAFT.markdown);
    expect(type).toBe('text/markdown;charset=utf-8');
  });

  it('offers copy and download and nothing that publishes', async () => {
    const screen = await prepared();
    expect(screen.queryByText(/publish|github|create issue|post/i)).toBeNull();
    expect(screen.getAllByRole('button').map((node) => node.props.testID)).toEqual(
      expect.not.arrayContaining(['draft-publish']),
    );
  });
});
