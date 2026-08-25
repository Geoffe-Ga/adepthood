/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import ExportDataScreen from '../ExportDataScreen';
import { saveDataExport, type SavedExport } from '../saveDataExport';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('../saveDataExport', () => ({
  saveDataExport: jest.fn(),
}));

const mockSaveDataExport = saveDataExport as jest.MockedFunction<typeof saveDataExport>;

const JSON_RESULT: SavedExport = {
  filename: 'adepthood-export-2026-08-22.json',
  uri: 'file:///documents/adepthood-export-2026-08-22.json',
  records: 1240,
  shared: true,
};

const MARKDOWN_RESULT: SavedExport = {
  filename: 'adepthood-journal-2026-08-22.md',
  uri: 'file:///documents/adepthood-journal-2026-08-22.md',
  records: null,
  shared: false,
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

  test('a failed export says nothing was saved rather than showing a receipt', async () => {
    mockSaveDataExport.mockRejectedValue(new Error('The server is unreachable.'));
    const { getByTestId, queryByTestId } = render(<ExportDataScreen />);

    fireEvent.press(getByTestId('export-data-json'));

    await waitFor(() => expect(getByTestId('export-data-error')).toBeTruthy());
    expect(getByTestId('export-data-error').props.children as string).toContain(
      'The server is unreachable.',
    );
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
