/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import type { ContentItem } from '../../../api';
import { deriveChapterNeighbors } from '../chapterNav';

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 1,
    title: 'Test Article',
    content_type: 'chapter',
    release_day: 0,
    url: 'content://beige-1',
    is_locked: false,
    is_read: false,
    ...overrides,
  };
}

describe('deriveChapterNeighbors', () => {
  it('returns both neighbors for an item in the middle of the list', () => {
    const first = makeItem({ id: 1, title: 'One' });
    const middle = makeItem({ id: 2, title: 'Two' });
    const last = makeItem({ id: 3, title: 'Three' });
    const content = [first, middle, last];

    const result = deriveChapterNeighbors(content, 2);

    expect(result).toEqual({ prev: first, next: last, nextIsDone: false });
  });

  it('returns a null prev and a non-null next for the first item', () => {
    const first = makeItem({ id: 1, title: 'One' });
    const second = makeItem({ id: 2, title: 'Two' });
    const content = [first, second];

    const result = deriveChapterNeighbors(content, 1);

    expect(result).toEqual({ prev: null, next: second, nextIsDone: false });
  });

  it('returns a null next and nextIsDone true for the last item', () => {
    const first = makeItem({ id: 1, title: 'One' });
    const last = makeItem({ id: 2, title: 'Two' });
    const content = [first, last];

    const result = deriveChapterNeighbors(content, 2);

    expect(result).toEqual({ prev: first, next: null, nextIsDone: true });
  });

  it('reports nextIsDone true when the next item is locked', () => {
    const first = makeItem({ id: 1, title: 'One' });
    const lockedNext = makeItem({ id: 2, title: 'Two', is_locked: true });
    const content = [first, lockedNext];

    const result = deriveChapterNeighbors(content, 1);

    expect(result).toEqual({ prev: null, next: lockedNext, nextIsDone: true });
  });

  it('returns null neighbors and nextIsDone true when the current id is not in the list', () => {
    const content = [makeItem({ id: 1 }), makeItem({ id: 2 })];

    const result = deriveChapterNeighbors(content, 999);

    expect(result).toEqual({ prev: null, next: null, nextIsDone: true });
  });
});
