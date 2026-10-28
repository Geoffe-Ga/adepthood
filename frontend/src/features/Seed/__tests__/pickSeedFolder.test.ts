/* eslint-env jest */
/* global describe, test, expect, jest, afterEach */
import { Platform } from 'react-native';

import {
  browserFolderPickerHost,
  FOCUS_RETURN_SETTLE_MS,
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

/** A page whose focus the test hands back, as a dismissed dialog does. */
class FakeFocus {
  private listeners: Listener[] = [];

  watch = (listener: Listener): (() => void) => {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((watched) => watched !== listener);
    };
  };

  get watching(): number {
    return this.listeners.length;
  }

  regain(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

function focusHostWith(input: FakeDirectoryInput, focus: FakeFocus): FolderPickerHost<FakeFile> {
  return { createDirectoryInput: () => input, watchFocusReturn: focus.watch };
}

/** Whether a promise has settled, without waiting on it. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const winner = await Promise.race([promise, Promise.resolve(pending)]);
  return winner !== pending;
}

const originalOS = Platform.OS;

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
  jest.useRealTimers();
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

  test('answers a dialog dismissed without a cancel event as cancelled once focus returns', async () => {
    jest.useFakeTimers();
    const input = new FakeDirectoryInput();
    const focus = new FakeFocus();
    const picking = pickSeedFolder(focusHostWith(input, focus));
    focus.regain();
    jest.advanceTimersByTime(FOCUS_RETURN_SETTLE_MS - 1);
    expect(await hasSettled(picking)).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(picking).resolves.toEqual({ kind: 'cancelled' });
    expect(input.removed).toBe(true);
    expect(focus.watching).toBe(0);
  });

  test('keeps the folder when its files arrive just after focus returns', async () => {
    jest.useFakeTimers();
    const input = new FakeDirectoryInput();
    const focus = new FakeFocus();
    const picking = pickSeedFolder(focusHostWith(input, focus));
    focus.regain();
    const files = [{ name: 'a.md', size: 1, webkitRelativePath: 'V/a.md' }];
    input.files = files;
    input.fire('change');
    jest.advanceTimersByTime(FOCUS_RETURN_SETTLE_MS);
    await expect(picking).resolves.toEqual({ kind: 'picked', files });
    expect(focus.watching).toBe(0);
  });

  test('settles a pick left open as cancelled when another starts, and releases its input', async () => {
    const first = new FakeDirectoryInput();
    const firstPick = pickSeedFolder(hostWith(first));
    const second = new FakeDirectoryInput();
    const secondPick = pickSeedFolder(hostWith(second));
    await expect(firstPick).resolves.toEqual({ kind: 'cancelled' });
    expect(first.removed).toBe(true);
    expect(second.removed).toBe(false);
    const files = [{ name: 'a.md', size: 1, webkitRelativePath: 'V/a.md' }];
    second.files = files;
    second.fire('change');
    await expect(secondPick).resolves.toEqual({ kind: 'picked', files });
  });

  test('releases its input once however many ways it settles', async () => {
    const input = new FakeDirectoryInput();
    const removals = jest.spyOn(input, 'remove');
    const picking = pickSeedFolder(hostWith(input));
    input.fire('cancel');
    input.fire('change');
    await picking;
    await pickSeedFolder(null);
    expect(removals).toHaveBeenCalledTimes(1);
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

  test('watches the window for focus returning, and stops when asked', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const element = { webkitdirectory: false, style: { display: '' } };
    const document = { createElement: jest.fn(() => element), body: { appendChild: jest.fn() } };
    const window = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
    const listener = jest.fn();
    const stop = browserFolderPickerHost(document, window)?.watchFocusReturn?.(listener);
    expect(window.addEventListener).toHaveBeenCalledWith('focus', listener);
    stop?.();
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', listener);
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
