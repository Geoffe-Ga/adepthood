/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import React from 'react';

import SeedCorpusScreen from '../SeedCorpusScreen';

import { setActiveUser } from '@/storage/userScope';
import { resetAllStores } from '@/store/registry';
import { pipelineAnswer, receipt } from '@/testing/vaultPipelineFixtures';

/**
 * The Seed screen, end to end through its own fetch: a document the vault took
 * shows the folder it landed in, read from the dashboard's receipts, and the
 * finished run opens "Your vault" (#3776). Kept in its own file so the run's
 * own suite stays about the run.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    dispatch: jest.fn(),
    addListener: () => () => undefined,
  }),
}));

const PIPELINE_PATH = '/vault/pipeline';
const pipelineReads = jest.fn();

function json(status: number, body: unknown): Promise<unknown> {
  return Promise.resolve({ ok: true, status, json: () => Promise.resolve(body) });
}

const IMPORT_ACCEPTED = {
  destination: 'vault',
  stored: true,
  vault_status: 'accepted',
  vault_ref: 'frag-1',
  tags: [],
  corpus_status: null,
  fragment_id: null,
  message: 'ok',
};

global.fetch = ((url: string) => {
  const path = new URL(String(url)).pathname;
  if (path === '/vault/connection') {
    return json(200, { connected: true, vault_url: 'https://v.example', mcp_address: null });
  }
  if (path === PIPELINE_PATH) {
    pipelineReads();
    return json(
      200,
      pipelineAnswer({
        recent_uploads: [receipt({ filename: 'essay.md', landed_in: '01-Fragments/Writing' })],
      }),
    );
  }
  return json(202, IMPORT_ACCEPTED);
}) as unknown as typeof fetch;

const getDocumentAsync = DocumentPicker.getDocumentAsync as unknown as jest.Mock;
const mocked = FileSystem as unknown as { __fileBase64: jest.Mock; __fileSize: jest.Mock };

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  resetAllStores();
  getDocumentAsync.mockResolvedValue({
    canceled: false,
    assets: [{ name: 'essay.md', uri: 'file:///cache/essay.md', size: 512, lastModified: 0 }],
  });
  mocked.__fileBase64.mockResolvedValue('c2VlZA==');
  mocked.__fileSize.mockReturnValue(512);
});

afterEach(() => {
  setActiveUser(null);
});

describe('where a seeded file landed', () => {
  test('a landed row names its folder, and the finished run opens "Your vault"', async () => {
    const screen = render(<SeedCorpusScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('seed-choose-button'));
    });

    const landed = await screen.findByTestId(/^seed-item-landed-seed-\d+$/u);
    expect(landed).toHaveTextContent('Landed in Writing');
    expect(pipelineReads).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('seed-open-vault-dashboard'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('VaultDashboard'));
  });
});
