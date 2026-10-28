/* eslint-env jest */
/* global describe, test, expect, jest */
import { act, renderHook } from '@testing-library/react-native';

import { MAX_FOLDER_ENUMERATED_FILES } from '../folderManifest';
import type { DirectoryInputLike, FolderPickerHost } from '../pickSeedFolder';
import { SEED_FOLDER_EMPTY_NOTICE, SEED_FOLDER_TOO_MANY_NOTICE } from '../seedFolderCopy';
import { useSeedFolder } from '../useSeedFolder';

interface FakeFile {
  name: string;
  size: number;
  webkitRelativePath: string;
  arrayBuffer: jest.Mock;
}

function file(webkitRelativePath: string, size = 10): FakeFile {
  const name = webkitRelativePath.slice(webkitRelativePath.lastIndexOf('/') + 1);
  return { name, size, webkitRelativePath, arrayBuffer: jest.fn() };
}

/** A host whose next dialog answers with `files`, or is dismissed when null. */
function hostAnswering(fakes: FakeFile[] | null): FolderPickerHost<File> {
  // The fakes carry only what a manifest reads, plus a spy that fails the
  // "never read" assertions if anything opens one.
  const files = fakes as unknown as File[] | null;
  return {
    createDirectoryInput: () => {
      const listeners: Record<string, () => void> = {};
      const input: DirectoryInputLike<File> = {
        type: '',
        multiple: false,
        webkitdirectory: false,
        files,
        addEventListener: (type, listener) => {
          listeners[type] = listener;
        },
        click: () => {
          const fire = files === null ? listeners.cancel : listeners.change;
          fire?.();
        },
        remove: () => undefined,
      };
      return input;
    },
  };
}

const VAULT = [
  file('My Vault/Work/Index.md', 10),
  file('My Vault/Home/Index.md', 20),
  file('My Vault/assets/diagram.png', 300),
  file('My Vault/.obsidian/app.json', 5),
];

async function reviewing(files: FakeFile[]) {
  const send = jest.fn().mockResolvedValue(undefined);
  const hook = renderHook(() => useSeedFolder(send, hostAnswering(files)));
  await act(async () => {
    await hook.result.current.chooseFolder();
  });
  return { send, hook };
}

describe('useSeedFolder', () => {
  test('is unsupported, and opens nothing, without a folder picker', async () => {
    const send = jest.fn();
    const { result } = renderHook(() => useSeedFolder(send, null));
    expect(result.current.supported).toBe(false);
    await act(async () => {
      await result.current.chooseFolder();
    });
    expect(result.current.review).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('opens a review, not an upload, once a folder is chosen', async () => {
    const { send, hook } = await reviewing(VAULT);
    const review = hook.result.current.review;
    expect(review?.namespace).toBe('My Vault');
    expect(review?.includeAttachments).toBe(false);
    expect(review?.selection.entries.map((entry) => entry.relativePath)).toEqual([
      'Home/Index.md',
      'Work/Index.md',
    ]);
    expect(review?.manifest.skipped.configuration).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  test('sends nothing and drops the folder when the review is dismissed', async () => {
    const { send, hook } = await reviewing(VAULT);
    act(() => hook.result.current.dismiss());
    expect(hook.result.current.review).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  test('starts with the selected notes, each named by where it sat', async () => {
    const { send, hook } = await reviewing(VAULT);
    await act(async () => {
      await hook.result.current.start();
    });
    expect(send).toHaveBeenCalledTimes(1);
    const documents = send.mock.calls[0][0];
    expect(documents).toEqual([
      expect.objectContaining({
        name: 'Index.md',
        size: 20,
        seedable: true,
        browserFile: VAULT[1],
        source: { namespace: 'My Vault', relativePath: 'Home/Index.md' },
      }),
      expect.objectContaining({
        name: 'Index.md',
        source: { namespace: 'My Vault', relativePath: 'Work/Index.md' },
      }),
    ]);
    expect(hook.result.current.review).toBeNull();
  });

  test('sends the attachments too once they are asked for', async () => {
    const { send, hook } = await reviewing(VAULT);
    act(() => hook.result.current.setIncludeAttachments(true));
    await act(async () => {
      await hook.result.current.start();
    });
    const paths = send.mock.calls[0][0].map(
      (document: { source: { relativePath: string } }) => document.source.relativePath,
    );
    expect(paths).toEqual(['Home/Index.md', 'Work/Index.md', 'assets/diagram.png']);
  });

  test('sends under an edited import name, normalized', async () => {
    const { send, hook } = await reviewing(VAULT);
    act(() => hook.result.current.setNamespace('Café notes'));
    await act(async () => {
      await hook.result.current.start();
    });
    expect(send.mock.calls[0][0][0].source.namespace).toBe('Café notes');
  });

  test('will not start under a name the server would refuse', async () => {
    const { send, hook } = await reviewing(VAULT);
    act(() => hook.result.current.setNamespace(' padded '));
    expect(hook.result.current.review?.blocker).not.toBeNull();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('will not start when nothing is selected', async () => {
    const { send, hook } = await reviewing([file('My Vault/diagram.png')]);
    expect(hook.result.current.review?.blocker).not.toBeNull();
    await act(async () => {
      await hook.result.current.start();
    });
    expect(send).not.toHaveBeenCalled();
  });

  test('never reads a file while reviewing or dismissing', async () => {
    const { hook } = await reviewing(VAULT);
    act(() => hook.result.current.setIncludeAttachments(true));
    act(() => hook.result.current.dismiss());
    for (const handle of VAULT) expect(handle.arrayBuffer).not.toHaveBeenCalled();
  });

  test('says an empty folder is empty, and opens no review', async () => {
    const { hook } = await reviewing([]);
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.notice).toBe(SEED_FOLDER_EMPTY_NOTICE);
  });

  test('refuses a folder past the file bound before reviewing it', async () => {
    const many = Array.from({ length: MAX_FOLDER_ENUMERATED_FILES + 1 }, (_value, index) =>
      file(`My Vault/${index}.md`),
    );
    const { hook } = await reviewing(many);
    expect(hook.result.current.review).toBeNull();
    expect(hook.result.current.notice).toBe(SEED_FOLDER_TOO_MANY_NOTICE);
  });

  test('says nothing and opens nothing when the dialog is dismissed', async () => {
    const send = jest.fn();
    const { result } = renderHook(() => useSeedFolder(send, hostAnswering(null)));
    await act(async () => {
      await result.current.chooseFolder();
    });
    expect(result.current.review).toBeNull();
    expect(result.current.notice).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});
