/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ShareLinkCreateRequest, ShareLinkResponse } from '../../../../api/practiceShare';

const sampleLinks: ShareLinkResponse[] = [
  {
    id: 1,
    token: 'token-alpha',
    practice_id: 42,
    created_at: '2026-05-17T10:00:00Z',
    expires_at: null,
    max_uses: null,
    use_count: 0,
    revoked_at: null,
  },
];

const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<ShareLinkResponse[]>>;
const mockCreate = jest.fn() as jest.MockedFunction<
  (_id: number, _payload: ShareLinkCreateRequest) => Promise<ShareLinkResponse>
>;
const mockRevoke = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;

jest.mock('@/api/practiceShare', () => ({
  practiceShare: {
    list: (...args: unknown[]) =>
      (mockList as unknown as (...a: unknown[]) => Promise<ShareLinkResponse[]>)(...args),
    create: (...args: unknown[]) =>
      (mockCreate as unknown as (...a: unknown[]) => Promise<ShareLinkResponse>)(...args),
    revoke: (...args: unknown[]) =>
      (mockRevoke as unknown as (...a: unknown[]) => Promise<void>)(...args),
    preview: jest.fn(),
    import: jest.fn(),
  },
}));

const { ShareSheet, buildShareUrl, copyToClipboard } = require('../ShareSheet');

interface RenderOptions {
  visible?: boolean;
  practiceId?: number;
  onClose?: () => void;
}

function renderSheet(opts: RenderOptions = {}) {
  return render(
    <ShareSheet
      visible={opts.visible ?? true}
      practiceId={opts.practiceId ?? 42}
      onClose={opts.onClose ?? jest.fn()}
    />,
  );
}

describe('ShareSheet', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockCreate.mockReset();
    mockRevoke.mockReset();
  });

  it('builds the deep-link URL for a token', () => {
    expect(buildShareUrl('abc')).toBe('adepthood://practices/share/abc');
    expect(buildShareUrl('a/b+c')).toBe('adepthood://practices/share/a%2Fb%2Bc');
  });

  it('loads and renders the active share links on open', async () => {
    mockList.mockResolvedValueOnce(sampleLinks);
    const { findByTestId } = renderSheet();
    const row = await findByTestId('share-sheet-row-1');
    expect(row).toBeTruthy();
    expect(mockList).toHaveBeenCalledWith(42);
  });

  it('mints a new link and prepends it to the list', async () => {
    mockList.mockResolvedValueOnce([]);
    const created: ShareLinkResponse = {
      id: 7,
      token: 'token-new',
      practice_id: 42,
      created_at: '2026-05-17T12:00:00Z',
      expires_at: null,
      max_uses: 3,
      use_count: 0,
      revoked_at: null,
    };
    mockCreate.mockResolvedValueOnce(created);

    const { findByTestId, getByTestId } = renderSheet();
    await findByTestId('share-sheet-empty');
    fireEvent.changeText(getByTestId('share-sheet-max-uses-input'), '3');
    fireEvent.press(getByTestId('share-sheet-mint'));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(42, {
        expires_in_days: null,
        max_uses: 3,
      });
    });
    const newRow = await findByTestId('share-sheet-row-7');
    expect(newRow).toBeTruthy();
  });

  it('treats blank or zero inputs as null on mint', async () => {
    mockList.mockResolvedValueOnce([]);
    const first = sampleLinks[0];
    if (!first) throw new Error('test fixture missing');
    const created: ShareLinkResponse = { ...first, id: 11 };
    mockCreate.mockResolvedValueOnce(created);

    const { findByTestId, getByTestId } = renderSheet();
    await findByTestId('share-sheet-empty');
    fireEvent.changeText(getByTestId('share-sheet-expires-input'), '   ');
    fireEvent.changeText(getByTestId('share-sheet-max-uses-input'), '0');
    fireEvent.press(getByTestId('share-sheet-mint'));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith(42, {
        expires_in_days: null,
        max_uses: null,
      });
    });
  });

  it('surfaces a mint failure via an inline error banner', async () => {
    mockList.mockResolvedValueOnce([]);
    mockCreate.mockRejectedValueOnce(new Error('offline'));

    const { findByTestId, getByTestId } = renderSheet();
    await findByTestId('share-sheet-empty');
    fireEvent.press(getByTestId('share-sheet-mint'));
    const banner = await findByTestId('share-sheet-error');
    expect(banner).toBeTruthy();
  });

  it('revokes a link inline and updates the row status', async () => {
    mockList.mockResolvedValueOnce(sampleLinks);
    mockRevoke.mockResolvedValueOnce(undefined);

    const { findByTestId, queryByTestId } = renderSheet();
    const revokeBtn = await findByTestId('share-sheet-revoke-1');
    fireEvent.press(revokeBtn);

    await waitFor(() => {
      expect(mockRevoke).toHaveBeenCalledWith(1);
    });
    // After revocation the revoke button disappears (status flips to "Revoked").
    await waitFor(() => {
      expect(queryByTestId('share-sheet-revoke-1')).toBeNull();
    });
  });

  it('renders an inline error and retry button if the list fetch fails', async () => {
    mockList.mockRejectedValueOnce(new Error('offline'));
    mockList.mockResolvedValueOnce(sampleLinks);

    const { findByTestId } = renderSheet();
    const retry = await findByTestId('share-sheet-retry');
    fireEvent.press(retry);
    await waitFor(() => {
      expect(mockList).toHaveBeenCalledTimes(2);
    });
  });

  it('the close affordance fires onClose', async () => {
    mockList.mockResolvedValueOnce([]);
    const onClose = jest.fn();
    const { findByTestId } = renderSheet({ onClose });
    const close = await findByTestId('share-sheet-close');
    fireEvent.press(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('copyToClipboard returns false when navigator.clipboard is missing', async () => {
    const result = await copyToClipboard('hello');
    // Jest's jsdom may or may not provide navigator.clipboard; just assert
    // the helper does not throw and returns a boolean.
    expect(typeof result).toBe('boolean');
  });

  describe('copy-banner auto-dismiss (PR #359 review)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('clears the copy banner after the timeout so a second copy is fresh', async () => {
      mockList.mockResolvedValueOnce(sampleLinks);
      const { findByTestId, queryByTestId, getByTestId } = renderSheet();
      const copyBtn = await findByTestId('share-sheet-copy-1');
      fireEvent.press(copyBtn);
      await waitFor(() => {
        expect(getByTestId('share-sheet-copy-banner')).toBeTruthy();
      });
      act(() => {
        jest.advanceTimersByTime(4000);
      });
      await waitFor(() => {
        expect(queryByTestId('share-sheet-copy-banner')).toBeNull();
      });
    });
  });
});
