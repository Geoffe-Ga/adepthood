/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ExportDataScreen from '../ExportDataScreen';
import { saveDataExport, type SavedExport } from '../saveDataExport';

import { ApiError } from '@/api';
import { expectNavigationOwnsTitle, watchFocusMoves } from '@/testing/navigationOwnsTitle';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('../saveDataExport', () => ({
  saveDataExport: jest.fn(),
}));

const mockSaveDataExport = saveDataExport as jest.MockedFunction<typeof saveDataExport>;

const JSON_RESULT: SavedExport = {
  filename: 'adepthood-export-2026-08-22.json',
  uri: 'file:///documents/adepthood-export-2026-08-22.json',
  records: 1240,
  destination: 'shared',
};

const MARKDOWN_RESULT: SavedExport = {
  filename: 'adepthood-journal-2026-08-22.md',
  uri: 'file:///documents/adepthood-journal-2026-08-22.md',
  records: null,
  destination: 'device-file',
};

const WEB_RESULT: SavedExport = {
  filename: 'adepthood-export-2026-08-22.json',
  uri: null,
  records: 1240,
  destination: 'browser-download',
};

const VAULT_RESULT: SavedExport = {
  filename: 'adepthood-vault-2026-08-22.json',
  uri: 'file:///documents/adepthood-vault-2026-08-22.json',
  records: null,
  destination: 'shared',
  vault: { items: 14, complete: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSaveDataExport.mockResolvedValue(JSON_RESULT);
});

describe('ExportDataScreen', () => {
  test('offers both formats before anything is pressed', () => {
    const { getByTestId } = render(<ExportDataScreen />);

    expect(getByTestId('export-data-json')).toBeTruthy();
    expect(getByTestId('export-data-markdown')).toBeTruthy();
  });

  test('warns that the exported file is readable plaintext', () => {
    const { getByTestId } = render(<ExportDataScreen />);

    const caution = getByTestId('export-data-caution').props.children as string;
    expect(caution).toContain('decrypts');
    expect(caution).toContain('readable by anyone');
  });

  test('names what the archive leaves out instead of overclaiming', () => {
    const { getByTestId } = render(<ExportDataScreen />);

    expect(getByTestId('export-data-not-included')).toBeTruthy();
  });

  test('the JSON button runs the JSON export and reports what was saved', async () => {
    const { getByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-json'));

    await waitFor(() => expect(getByTestId('export-data-receipt')).toBeTruthy());
    expect(mockSaveDataExport).toHaveBeenCalledWith('json');
    const saved = getByTestId('export-data-receipt-saved').props.children as string;
    expect(saved).toContain('1240 records');
    expect(saved).toContain('adepthood-export-2026-08-22.json');
  });

  test('the Markdown button runs the Markdown export and says where it went', async () => {
    mockSaveDataExport.mockResolvedValue(MARKDOWN_RESULT);
    const { getByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-markdown'));

    await waitFor(() => expect(getByTestId('export-data-receipt')).toBeTruthy());
    expect(mockSaveDataExport).toHaveBeenCalledWith('markdown');
    const saved = getByTestId('export-data-receipt-saved').props.children as string;
    expect(saved).toContain('your journal');
    expect(getByTestId('export-data-receipt-next').props.children as string).toContain(
      'on this device',
    );
  });

  test('a web export says that the browser downloaded the file', async () => {
    mockSaveDataExport.mockResolvedValue(WEB_RESULT);
    const { getByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-json'));

    await waitFor(() => expect(getByTestId('export-data-receipt')).toBeTruthy());
    expect(getByTestId('export-data-receipt-next').props.children as string).toContain(
      'browser downloaded',
    );
  });

  test('a failed export says nothing was saved rather than showing a receipt', async () => {
    mockSaveDataExport.mockRejectedValue(new Error('The server is unreachable.'));
    const { getByTestId, queryByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-json'));

    await waitFor(() => expect(getByTestId('export-data-error')).toBeTruthy());
    const message = getByTestId('export-data-error').props.children as string;
    expect(message).toContain('Could not build the export');
    expect(message).not.toContain('The server is unreachable.');
    expect(queryByTestId('export-data-receipt')).toBeNull();
  });

  test('both buttons are disabled while one export is in flight', async () => {
    let release: (_value: SavedExport) => void = () => undefined;
    mockSaveDataExport.mockReturnValue(
      new Promise<SavedExport>((resolve) => {
        release = resolve;
      }),
    );
    const { getByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-json'));

    await waitFor(() =>
      expect(getByTestId('export-data-markdown').props.accessibilityState.disabled).toBe(true),
    );
    release(JSON_RESULT);
    await waitFor(() => expect(getByTestId('export-data-receipt')).toBeTruthy());
  });
});

describe('ExportDataScreen — what your vault holds (#3579)', () => {
  test('the vault button runs the vault export and counts what came back', async () => {
    mockSaveDataExport.mockResolvedValue(VAULT_RESULT);
    const { getByTestId, queryByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-vault'));

    await waitFor(() => expect(getByTestId('export-data-receipt')).toBeTruthy());
    expect(mockSaveDataExport).toHaveBeenCalledWith('vault');
    const saved = getByTestId('export-data-receipt-saved').props.children as string;
    expect(saved).toContain('14 items from your vault');
    expect(saved).toContain('adepthood-vault-2026-08-22.json');
    expect(queryByTestId('export-data-receipt-incomplete')).toBeNull();
  });

  test('a copy the vault stopped partway through is saved and called incomplete', async () => {
    mockSaveDataExport.mockResolvedValue({
      ...VAULT_RESULT,
      vault: { items: 3, complete: false },
    });
    const { getByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-vault'));

    await waitFor(() => expect(getByTestId('export-data-receipt-incomplete')).toBeTruthy());
    const warning = getByTestId('export-data-receipt-incomplete').props.children as string;
    expect(warning).toContain('incomplete');
    expect(warning).toContain('Try again');
  });

  test.each([
    ['vault_unavailable', 503, 'asleep or unreachable'],
    ['vault_export_needs_update', 409, 'needs an update before its content can be exported'],
    ['vault_not_connected', 404, 'no Creek Vault'],
    ['vault_export_failed', 502, 'could not finish the export'],
  ])(
    'a vault answering %s says so rather than saving an empty file',
    async (detail, status, says) => {
      mockSaveDataExport.mockRejectedValue(new ApiError(status, detail));
      const { getByTestId, queryByTestId } = render(<ExportDataScreen />);

      fireEvent.press(getByTestId('export-data-vault'));

      await waitFor(() => expect(getByTestId('export-data-error')).toBeTruthy());
      expect(getByTestId('export-data-error').props.children as string).toContain(says);
      expect(queryByTestId('export-data-receipt')).toBeNull();
    },
  );
});

describe('ExportDataScreen — navigation owns the title (#2962)', () => {
  test('paints no "Export my data" title, keeps one header named by it, and moves no focus', () => {
    const focus = watchFocusMoves();
    const screen = render(<ExportDataScreen />);
    expectNavigationOwnsTitle(screen, 'Export my data');
    expect(screen.getByTestId('export-data-lead')).toBeTruthy();
    focus.expectNone();
  });
});
