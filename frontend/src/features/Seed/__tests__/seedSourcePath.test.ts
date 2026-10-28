/* eslint-env jest */
/* global describe, test, expect */
import {
  isSafeSourceNamespace,
  isSafeSourceRelativePath,
  MAX_SOURCE_NAMESPACE_LENGTH,
  MAX_SOURCE_RELATIVE_PATH_LENGTH,
  normalizeSourceText,
} from '../seedSourcePath';

import { readBackendSource } from '@/testing/backendSource';

/** `e` + combining acute: the NFD spelling macOS hands out for `é`. */
const NFD_E_ACUTE = 'é';
const NFC_E_ACUTE = 'é';

describe('normalizeSourceText', () => {
  test('reads every spelling in NFC, as the backend does', () => {
    expect(normalizeSourceText(`Caf${NFD_E_ACUTE}.md`)).toBe(`Caf${NFC_E_ACUTE}.md`);
  });
});

describe('isSafeSourceNamespace', () => {
  test('accepts an ordinary folder name, spaces and all', () => {
    expect(isSafeSourceNamespace('My Vault')).toBe(true);
    expect(isSafeSourceNamespace('日記')).toBe(true);
  });

  test('refuses a blank, padded or control-bearing name', () => {
    expect(isSafeSourceNamespace('')).toBe(false);
    expect(isSafeSourceNamespace(' My Vault')).toBe(false);
    expect(isSafeSourceNamespace('My Vault ')).toBe(false);
    expect(isSafeSourceNamespace('My\nVault')).toBe(false);
    expect(isSafeSourceNamespace('My‮Vault')).toBe(false);
  });

  test('counts length in code points, as Python does', () => {
    expect(isSafeSourceNamespace('😀'.repeat(MAX_SOURCE_NAMESPACE_LENGTH))).toBe(true);
    expect(isSafeSourceNamespace('a'.repeat(MAX_SOURCE_NAMESPACE_LENGTH + 1))).toBe(false);
  });
});

describe('isSafeSourceRelativePath', () => {
  test('accepts nested plain names joined by /', () => {
    expect(isSafeSourceRelativePath('Work/Index.md')).toBe(true);
    expect(isSafeSourceRelativePath('Index.md')).toBe(true);
    expect(isSafeSourceRelativePath('a b/c d/e f.md')).toBe(true);
  });

  test.each([
    ['absolute', '/Work/Index.md'],
    ['empty component', 'Work//Index.md'],
    ['trailing separator', 'Work/'],
    ['dot component', 'Work/./Index.md'],
    ['dot-dot component', 'Work/../Index.md'],
    ['backslash', 'Work\\Index.md'],
    ['UNC', '\\\\server\\share\\Index.md'],
    ['drive prefix', 'C:Index.md'],
    ['control character', 'Work/In\u0000dex.md'],
    ['empty', ''],
  ])('refuses a %s path', (_label, value) => {
    expect(isSafeSourceRelativePath(value)).toBe(false);
  });

  test('refuses a path past the backend bound', () => {
    const long = 'a/'.repeat(MAX_SOURCE_RELATIVE_PATH_LENGTH / 2) + 'b.md';
    expect(isSafeSourceRelativePath(long)).toBe(false);
  });
});

describe('the bounds mirrored from the backend', () => {
  const source = readBackendSource('src', 'domain', 'upload_source.py');

  function backendConstant(name: string): number {
    const match = new RegExp(`^${name} = (\\d+)$`, 'm').exec(source);
    if (match === null) throw new Error(`${name} not found in backend/src/domain/upload_source.py`);
    return Number(match[1]);
  }

  test('match the namespace bound the server enforces', () => {
    expect(MAX_SOURCE_NAMESPACE_LENGTH).toBe(backendConstant('MAX_SOURCE_NAMESPACE_LENGTH'));
  });

  test('match the relative-path bound the server enforces', () => {
    expect(MAX_SOURCE_RELATIVE_PATH_LENGTH).toBe(
      backendConstant('MAX_SOURCE_RELATIVE_PATH_LENGTH'),
    );
  });
});
