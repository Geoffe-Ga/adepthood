/* eslint-env jest */
import { describe, it, expect } from '@jest/globals';

import {
  MAX_PAGES_PER_SESSION,
  canAddPages,
  capReachedCopy,
  captureSessionReducer,
} from '../captureSession';
import type { CapturePage } from '../captureSession';

function page(id: string, overrides: Partial<CapturePage> = {}): CapturePage {
  return {
    id,
    sourceUri: `file:///${id}-source.jpg`,
    uri: `file:///${id}.jpg`,
    imageBase64: `b64-${id}`,
    byteLength: 1024,
    mediaType: 'image/jpeg',
    status: 'ready',
    ...overrides,
  };
}

function pages(ids: string[]): CapturePage[] {
  return ids.map((id) => page(id));
}

describe('captureSessionReducer — append', () => {
  it('appends to an empty session preserving order', () => {
    const result = captureSessionReducer([], { type: 'append', pages: pages(['a', 'b']) });
    expect(result.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('appends additively after the existing pages, preserving order', () => {
    const state = pages(['a', 'b']);
    const result = captureSessionReducer(state, { type: 'append', pages: pages(['c', 'd']) });
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps an append at MAX_PAGES_PER_SESSION, keeping the appended pages in order up to the cap', () => {
    const state = pages(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
    const incoming = pages(['n1', 'n2', 'n3', 'n4']);
    const result = captureSessionReducer(state, { type: 'append', pages: incoming });

    expect(result).toHaveLength(MAX_PAGES_PER_SESSION);
    expect(result.map((p) => p.id)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
      'e5',
      'e6',
      'e7',
      'e8',
      'n1',
      'n2',
    ]);
  });
});

describe('captureSessionReducer — remove', () => {
  it('removes by id, preserving the order of the rest', () => {
    const state = pages(['a', 'b', 'c']);
    const result = captureSessionReducer(state, { type: 'remove', id: 'b' });
    expect(result.map((p) => p.id)).toEqual(['a', 'c']);
  });
});

describe('captureSessionReducer — reorder', () => {
  it('replaces the order wholesale from action.pages', () => {
    const state = pages(['a', 'b', 'c']);
    const reordered = [...state].reverse();
    const result = captureSessionReducer(state, { type: 'reorder', pages: reordered });
    expect(result.map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('captureSessionReducer — clear', () => {
  it('empties the session', () => {
    const state = pages(['a', 'b']);
    const result = captureSessionReducer(state, { type: 'clear' });
    expect(result).toEqual([]);
  });
});

describe('canAddPages', () => {
  it('is true with nine pages', () => {
    const nine = pages(Array.from({ length: 9 }, (_v, i) => `p${i}`));
    expect(canAddPages(nine)).toBe(true);
  });

  it('is false at exactly ten pages', () => {
    const ten = pages(Array.from({ length: 10 }, (_v, i) => `p${i}`));
    expect(canAddPages(ten)).toBe(false);
  });
});

describe('capReachedCopy', () => {
  it('names the maximum page count', () => {
    expect(capReachedCopy).toContain(String(MAX_PAGES_PER_SESSION));
  });
});
