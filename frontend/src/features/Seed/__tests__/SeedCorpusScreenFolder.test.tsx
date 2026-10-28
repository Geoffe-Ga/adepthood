/* eslint-env jest */
/* global describe, test, expect, beforeEach, afterEach, jest */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import React from 'react';
import { Platform } from 'react-native';

import SeedCorpusScreen from '../SeedCorpusScreen';
import {
  SEED_CHOOSE_FOLDER_LABEL,
  SEED_FOLDER_DISMISS_LABEL,
  SEED_FOLDER_NAMESPACE_INVALID,
  SEED_FOLDER_START_LABEL,
} from '../seedFolderCopy';
import { SEED_FOLDER_PREVIEW_LIMIT } from '../SeedFolderReview';

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: jest.fn(),
    dispatch: jest.fn(),
    addListener: () => () => undefined,
  }),
}));

const mockImportFetch = jest.fn() as jest.Mock;
global.fetch = ((url: string, init?: RequestInit) =>
  String(url).endsWith('/vault/connection')
    ? Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ connected: true, vault_url: 'https://v.example', mcp_address: null }),
      })
    : mockImportFetch(url, init)) as unknown as typeof fetch;

/** A folder file: metadata the manifest reads, and a reader the upload step calls. */
interface FakeFile {
  name: string;
  size: number;
  webkitRelativePath: string;
  arrayBuffer: jest.Mock;
}

function file(webkitRelativePath: string, text = 'words'): FakeFile {
  const bytes = new TextEncoder().encode(text);
  const name = webkitRelativePath.slice(webkitRelativePath.lastIndexOf('/') + 1);
  return {
    name,
    size: bytes.byteLength,
    webkitRelativePath,
    arrayBuffer: jest.fn(() => Promise.resolve(bytes.buffer)),
  };
}

/** What the next folder dialog answers: files, or a dismissal when null. */
let nextFolder: FakeFile[] | null = null;
let inputsBuilt = 0;

/** A page whose inputs can choose a directory and answer with `nextFolder`. */
const fakeDocument = {
  createElement: () => {
    inputsBuilt += 1;
    const listeners: Record<string, () => void> = {};
    const element = {
      type: '',
      multiple: false,
      webkitdirectory: false,
      style: { display: '' },
      files: null as FakeFile[] | null,
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      click: () => {
        element.files = nextFolder;
        (nextFolder === null ? listeners.cancel : listeners.change)?.();
      },
      remove: () => undefined,
    };
    return element;
  },
  body: { appendChild: () => undefined },
  // React Native's web hover tracking listens on the document.
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const getDocumentAsync = DocumentPicker.getDocumentAsync as unknown as jest.Mock;

const globalRef = globalThis as { document?: unknown; window?: unknown };
const originalWindow = globalRef.window;
const originalOS = Platform.OS;

function setPlatform(os: typeof Platform.OS): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function vaultAccepted() {
  return Promise.resolve({
    ok: true,
    status: 202,
    json: () =>
      Promise.resolve({
        destination: 'vault',
        stored: true,
        vault_status: 'accepted',
        vault_ref: null,
        tags: [],
        corpus_status: null,
        fragment_id: null,
        message: 'ok',
      }),
  });
}

const VAULT = [
  file('My Vault/Work/Index.md', 'work'),
  file('My Vault/Home/Index.md', 'home'),
  file('My Vault/assets/diagram.png', 'png'),
  file('My Vault/.obsidian/app.json', '{}'),
  file('My Vault/cache/example.bin', 'bin'),
];

function sentBodies(): Array<Record<string, string>> {
  return mockImportFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

async function openReview(screen: ReturnType<typeof render>) {
  await act(async () => {
    fireEvent.press(screen.getByTestId('seed-choose-folder-button'));
  });
  await waitFor(() => expect(screen.getByTestId('seed-folder-review')).toBeTruthy());
}

beforeEach(() => {
  setPlatform('web');
  globalRef.document = fakeDocument;
  // The leave guard warns before a reload while a run is going over.
  globalRef.window = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
  nextFolder = VAULT;
  inputsBuilt = 0;
  mockImportFetch.mockReset();
  mockImportFetch.mockImplementation(() => vaultAccepted());
  for (const handle of VAULT) handle.arrayBuffer.mockClear();
});

afterEach(() => {
  setPlatform(originalOS);
  delete globalRef.document;
  globalRef.window = originalWindow;
});

describe('choosing a folder on the seeding screen', () => {
  test('offers a folder beside the files where the browser can choose one', () => {
    const screen = render(<SeedCorpusScreen />);
    expect(screen.getByLabelText(SEED_CHOOSE_FOLDER_LABEL)).toBeTruthy();
  });

  test('offers no folder on native, where the platform grants none', () => {
    setPlatform('ios');
    const screen = render(<SeedCorpusScreen />);
    expect(screen.queryByTestId('seed-choose-folder-button')).toBeNull();
    expect(screen.getByTestId('seed-choose-button')).toBeTruthy();
  });

  test('reviews the folder before sending anything', async () => {
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    expect(screen.getByTestId('seed-folder-namespace').props.value).toBe('My Vault');
    expect(screen.getByText('2 notes selected')).toBeTruthy();
    expect(screen.getByTestId('seed-folder-path-0')).toHaveTextContent('Home/Index.md');
    expect(screen.getByTestId('seed-folder-path-1')).toHaveTextContent('Work/Index.md');
    expect(screen.getByTestId('seed-folder-skipped')).toHaveTextContent(
      'Left out 2 files: 1 app settings, 1 of a kind nothing here reads.',
    );
    expect(screen.getByTestId('seed-privacy')).toBeTruthy();
    expect(mockImportFetch).not.toHaveBeenCalled();
    for (const handle of VAULT) expect(handle.arrayBuffer).not.toHaveBeenCalled();
  });

  test('lists the first paths of a large folder and sums up the rest', async () => {
    nextFolder = Array.from({ length: SEED_FOLDER_PREVIEW_LIMIT + 3 }, (_value, index) =>
      file(`My Vault/notes/${String(index).padStart(3, '0')}.md`),
    );
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    expect(screen.getByTestId(`seed-folder-path-${SEED_FOLDER_PREVIEW_LIMIT - 1}`)).toBeTruthy();
    expect(screen.queryByTestId(`seed-folder-path-${SEED_FOLDER_PREVIEW_LIMIT}`)).toBeNull();
    expect(screen.getByText('…and 3 more')).toBeTruthy();
    expect(screen.queryByTestId('seed-folder-attachments')).toBeNull();
    expect(screen.queryByTestId('seed-folder-skipped')).toBeNull();
  });

  test('sends nothing when the review is put aside', async () => {
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    fireEvent.press(screen.getByText(SEED_FOLDER_DISMISS_LABEL));

    expect(screen.queryByTestId('seed-folder-review')).toBeNull();
    expect(mockImportFetch).not.toHaveBeenCalled();
  });

  test('sends each selected note under its own path, at the chosen tier', async () => {
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    await act(async () => {
      fireEvent.press(screen.getByText(SEED_FOLDER_START_LABEL));
    });

    await waitFor(() => expect(mockImportFetch).toHaveBeenCalledTimes(2));
    expect(sentBodies().map((body) => [body.filename, body.source_relative_path])).toEqual([
      ['Index.md', 'Home/Index.md'],
      ['Index.md', 'Work/Index.md'],
    ]);
    for (const body of sentBodies()) {
      expect(body.source_namespace).toBe('My Vault');
      expect(body.classification).toBe('personal');
    }
    expect(VAULT[3]?.arrayBuffer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Work/Index.md')).toBeTruthy());
    expect(screen.getByText('Home/Index.md')).toBeTruthy();
  });

  test('sends the attachments too once they are switched on', async () => {
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    fireEvent(screen.getByTestId('seed-folder-attachments'), 'valueChange', true);
    await act(async () => {
      fireEvent.press(screen.getByText(SEED_FOLDER_START_LABEL));
    });

    await waitFor(() => expect(mockImportFetch).toHaveBeenCalledTimes(3));
    expect(sentBodies().map((body) => body.source_relative_path)).toEqual([
      'Home/Index.md',
      'Work/Index.md',
      'assets/diagram.png',
    ]);
  });

  test('holds the start until the import has a name the server accepts', async () => {
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    fireEvent.changeText(screen.getByTestId('seed-folder-namespace'), ' ');

    expect(screen.getByTestId('seed-folder-blocker')).toHaveTextContent(
      SEED_FOLDER_NAMESPACE_INVALID,
    );
    expect(screen.getByTestId('seed-folder-start').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(screen.getByTestId('seed-folder-start'));
    });
    expect(mockImportFetch).not.toHaveBeenCalled();
  });

  test('holds a reviewed folder while files picked meanwhile are still going over', async () => {
    let release = (): void => undefined;
    mockImportFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(vaultAccepted());
        }),
    );
    const loose = file('loose.md', 'loose');
    getDocumentAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [{ name: 'loose.md', uri: 'blob:loose', size: loose.size, file: loose }],
    });
    const screen = render(<SeedCorpusScreen />);
    await openReview(screen);

    await act(async () => {
      fireEvent.press(screen.getByTestId('seed-choose-button'));
    });
    await waitFor(() => expect(mockImportFetch).toHaveBeenCalledTimes(1));

    // One batch at a time: the folder waits rather than opening a second loop.
    expect(screen.getByTestId('seed-folder-start').props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent.press(screen.getByTestId('seed-folder-start'));
    });
    expect(mockImportFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(screen.getByTestId('seed-folder-start').props.accessibilityState.disabled).toBe(false),
    );
  });

  test('a dismissed folder dialog opens no review and sends nothing', async () => {
    nextFolder = null;
    const screen = render(<SeedCorpusScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('seed-choose-folder-button'));
    });

    expect(inputsBuilt).toBeGreaterThan(0);
    expect(screen.queryByTestId('seed-folder-review')).toBeNull();
    expect(mockImportFetch).not.toHaveBeenCalled();
  });

  test('an empty folder says so', async () => {
    nextFolder = [];
    const screen = render(<SeedCorpusScreen />);

    await act(async () => {
      fireEvent.press(screen.getByTestId('seed-choose-folder-button'));
    });

    expect(screen.getByTestId('seed-folder-notice')).toBeTruthy();
    expect(screen.queryByTestId('seed-folder-review')).toBeNull();
  });
});
