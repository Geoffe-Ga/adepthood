/* eslint-env jest */
/* global describe, test, expect, jest, afterEach */
import { Platform } from 'react-native';

import {
  browserFolderPickerHost,
  pickSeedFolder,
  type DirectoryInputLike,
  type FolderPickerHost,
} from '../pickSeedFolder';

interface FakeFile {
  name: string;
  size: number;
  webkitRelativePath: string;
}

type Listener = () => void;

/** A directory input the test drives: it records how it was set up and fires events on demand. */
class FakeDirectoryInput implements DirectoryInputLike<FakeFile> {
  type = '';
  multiple = false;
  webkitdirectory = false;
  files: FakeFile[] | null = null;
  clicks = 0;
  removed = false;
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: 'change' | 'cancel', listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  click(): void {
    this.clicks += 1;
  }

  remove(): void {
    this.removed = true;
  }

  fire(type: 'change' | 'cancel'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function hostWith(input: FakeDirectoryInput | null): FolderPickerHost<FakeFile> {
  return { createDirectoryInput: () => input };
}

const originalOS = Platform.OS;

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
});

describe('pickSeedFolder', () => {
  test('opens a directory-capable, multi-file input from the person’s own action', async () => {
    const input = new FakeDirectoryInput();
    const picking = pickSeedFolder(hostWith(input));
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.webkitdirectory).toBe(true);
    expect(input.clicks).toBe(1);
    input.files = [];
    input.fire('change');
    await picking;
  });

  test('hands back every file the folder held, with its path, and releases the input', async () => {
    const input = new FakeDirectoryInput();
    const picking = pickSeedFolder(hostWith(input));
    const files = [
      { name: 'Index.md', size: 1, webkitRelativePath: 'My Vault/Work/Index.md' },
      { name: 'Index.md', size: 2, webkitRelativePath: 'My Vault/Home/Index.md' },
    ];
    input.files = files;
    input.fire('change');
    await expect(picking).resolves.toEqual({ kind: 'picked', files });
    expect(input.removed).toBe(true);
  });

  test('answers a dismissed dialog as cancelled', async () => {
    const input = new FakeDirectoryInput();
    const picking = pickSeedFolder(hostWith(input));
    input.fire('cancel');
    await expect(picking).resolves.toEqual({ kind: 'cancelled' });
    expect(input.removed).toBe(true);
  });

  test('settles once, whichever event comes second', async () => {
    const input = new FakeDirectoryInput();
    const picking = pickSeedFolder(hostWith(input));
    input.fire('cancel');
    input.files = [{ name: 'a.md', size: 1, webkitRelativePath: 'V/a.md' }];
    input.fire('change');
    await expect(picking).resolves.toEqual({ kind: 'cancelled' });
  });

  test('treats a change with no file list as cancelled', async () => {
    const input = new FakeDirectoryInput();
    const picking = pickSeedFolder(hostWith(input));
    input.fire('change');
    await expect(picking).resolves.toEqual({ kind: 'cancelled' });
  });

  test('answers unavailable, without opening anything, where the platform has no folder picker', async () => {
    await expect(pickSeedFolder(null)).resolves.toEqual({ kind: 'unavailable' });
    await expect(pickSeedFolder(hostWith(null))).resolves.toEqual({ kind: 'unavailable' });
  });
});

describe('browserFolderPickerHost', () => {
  test('offers no folder picker on native, where no recursive access is granted', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    expect(browserFolderPickerHost()).toBeNull();
  });

  test('offers none on web without a document to build an input in', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    expect(browserFolderPickerHost(undefined)).toBeNull();
  });

  test('offers none on a browser whose inputs cannot choose a directory', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const document = { createElement: jest.fn(() => ({})), body: { appendChild: jest.fn() } };
    expect(browserFolderPickerHost(document)).toBeNull();
  });

  test('builds a hidden directory input, attached to the page, on a capable browser', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const element = { webkitdirectory: false, style: { display: '' } };
    const appendChild = jest.fn();
    const document = { createElement: jest.fn(() => element), body: { appendChild } };
    const host = browserFolderPickerHost(document);
    expect(host).not.toBeNull();
    const input = host?.createDirectoryInput();
    expect(input).toBe(element);
    expect(element.style.display).toBe('none');
    expect(appendChild).toHaveBeenCalledWith(element);
  });
});
