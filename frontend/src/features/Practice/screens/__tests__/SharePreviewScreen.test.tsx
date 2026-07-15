/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError } from '@/api';
import type { ShareLinkImportResponse, ShareLinkPreviewResponse } from '@/api/practiceShare';

const samplePreview: ShareLinkPreviewResponse = {
  practice_id: 99,
  stage_number: 3,
  name: 'Forest grounding',
  description: 'A 5-minute reset under canopy.',
  instructions: 'Find a tree, place a palm on the bark, breathe.',
  default_duration_minutes: 5,
  mode: 'mindful_anchor',
  mode_config: {},
  created_by_display_name: 'alice',
  expires_at: null,
  max_uses: null,
  use_count: 0,
};

const importedResponse: ShareLinkImportResponse = {
  practice_id: 250,
  stage_number: 3,
  name: 'Forest grounding',
  approved: false,
};

const mockPreview = jest.fn() as jest.MockedFunction<
  (_token: string) => Promise<ShareLinkPreviewResponse>
>;
const mockImport = jest.fn() as jest.MockedFunction<
  (_token: string) => Promise<ShareLinkImportResponse>
>;

jest.mock('@/api/practiceShare', () => ({
  practiceShare: {
    preview: (...args: unknown[]) =>
      (mockPreview as unknown as (...a: unknown[]) => Promise<ShareLinkPreviewResponse>)(...args),
    import: (...args: unknown[]) =>
      (mockImport as unknown as (...a: unknown[]) => Promise<ShareLinkImportResponse>)(...args),
    list: jest.fn(),
    create: jest.fn(),
    revoke: jest.fn(),
  },
}));

const { SharePreviewScreen } = require('../SharePreviewScreen');

interface NavMock {
  goBack: jest.Mock<() => void>;
  navigate: jest.Mock<(...args: unknown[]) => void>;
}

function makeNav(): NavMock {
  return {
    goBack: jest.fn() as jest.Mock<() => void>,
    navigate: jest.fn() as jest.Mock<(...args: unknown[]) => void>,
  };
}

function renderScreen(token = 'tok-1', navOverride?: NavMock) {
  const navigation = navOverride ?? makeNav();
  const route = { key: 'k', name: 'SharePreview' as const, params: { token } };
  const Screen = SharePreviewScreen as unknown as React.ComponentType<{
    navigation: NavMock;
    route: typeof route;
  }>;
  const view = render(<Screen navigation={navigation} route={route} />);
  return { view, navigation };
}

describe('SharePreviewScreen', () => {
  beforeEach(() => {
    mockPreview.mockReset();
    mockImport.mockReset();
  });

  it('shows a loading state then renders the practice preview', async () => {
    mockPreview.mockResolvedValueOnce(samplePreview);
    const { view } = renderScreen();
    expect(view.getByTestId('share-preview-loading')).toBeTruthy();
    const sender = await view.findByTestId('share-preview-sender');
    expect(sender.props.children.join('')).toContain('alice');
  });

  it('imports the practice when the user taps Import', async () => {
    mockPreview.mockResolvedValueOnce(samplePreview);
    mockImport.mockResolvedValueOnce(importedResponse);

    const { view } = renderScreen('tok-1');
    const importBtn = await view.findByTestId('share-preview-import');
    fireEvent.press(importBtn);
    await waitFor(() => {
      expect(mockImport).toHaveBeenCalledWith('tok-1');
    });
    const success = await view.findByTestId('share-preview-success');
    expect(success).toBeTruthy();
  });

  it('navigates to the Practice tab on tapping Open after a successful import', async () => {
    mockPreview.mockResolvedValueOnce(samplePreview);
    mockImport.mockResolvedValueOnce(importedResponse);

    const navigation = makeNav();
    const { view } = renderScreen('tok-1', navigation);
    fireEvent.press(await view.findByTestId('share-preview-import'));
    const done = await view.findByTestId('share-preview-done');
    fireEvent.press(done);
    expect(navigation.navigate).toHaveBeenCalledWith('Tabs', {
      screen: 'Practice',
      params: { stageNumber: 3 },
    });
  });

  it('calls goBack on Cancel', async () => {
    mockPreview.mockResolvedValueOnce(samplePreview);
    const navigation = makeNav();
    const { view } = renderScreen('tok-1', navigation);
    const cancel = await view.findByTestId('share-preview-cancel');
    fireEvent.press(cancel);
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
  });

  it('renders the revoked detail copy when the API returns 410 share_link_revoked', async () => {
    mockPreview.mockRejectedValueOnce(new ApiError(410, 'share_link_revoked'));
    const { view } = renderScreen('tok-1');
    expect(await view.findByText('This share link has been revoked.')).toBeTruthy();
  });

  it('renders the expired detail copy when the API returns 410 share_link_expired', async () => {
    mockPreview.mockRejectedValueOnce(new ApiError(410, 'share_link_expired'));
    const { view } = renderScreen('tok-1');
    expect(await view.findByText('This share link has expired.')).toBeTruthy();
  });

  it('renders the exhausted detail copy when the API returns 410 share_link_exhausted', async () => {
    mockPreview.mockRejectedValueOnce(new ApiError(410, 'share_link_exhausted'));
    const { view } = renderScreen('tok-1');
    expect(await view.findByText('This share link has reached its use limit.')).toBeTruthy();
  });

  it('renders the self-import banner when the API returns 400 cannot_import_own_practice', async () => {
    mockPreview.mockResolvedValueOnce(samplePreview);
    mockImport.mockRejectedValueOnce(new ApiError(400, 'cannot_import_own_practice'));
    const { view } = renderScreen('tok-1');
    fireEvent.press(await view.findByTestId('share-preview-import'));
    const banner = await view.findByTestId('share-preview-error-import');
    expect(banner).toBeTruthy();
  });

  it('shows a generic load error with a retry button on transient failure', async () => {
    mockPreview.mockRejectedValueOnce(new Error('offline'));
    mockPreview.mockResolvedValueOnce(samplePreview);
    const { view } = renderScreen('tok-1');
    const retry = await view.findByTestId('share-preview-retry');
    fireEvent.press(retry);
    await waitFor(() => {
      expect(mockPreview).toHaveBeenCalledTimes(2);
    });
  });
});
