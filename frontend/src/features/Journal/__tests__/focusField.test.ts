import { describe, expect, it, jest } from '@jest/globals';

import { focusWithoutScrolling } from '../focusField';

describe('focusWithoutScrolling (#3718)', () => {
  it('asks the browser not to scroll the field into view on web', () => {
    const focus = jest.fn();
    focusWithoutScrolling({ focus }, 'web');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('focuses plainly on native, where focus never scrolls a suppressed-keyboard field', () => {
    const focus = jest.fn();
    focusWithoutScrolling({ focus }, 'ios');
    expect(focus).toHaveBeenCalledWith();
  });

  it('does nothing before the field has mounted', () => {
    expect(() => focusWithoutScrolling(null, 'web')).not.toThrow();
  });
});
