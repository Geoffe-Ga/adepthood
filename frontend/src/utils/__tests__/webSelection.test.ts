import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const platformRef: { value: 'ios' | 'web' } = { value: 'web' };
jest.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformRef.value;
    },
  },
}));

import { applyWebSelectionTheme, WEB_SELECTION_CSS, WEB_SELECTION_STYLE_ID } from '../webSelection';

describe('applyWebSelectionTheme', () => {
  beforeEach(() => {
    platformRef.value = 'web';
  });

  it('installs one warm selection rule on web', () => {
    const elements: Array<{ id: string; textContent: string | null }> = [];
    const doc = {
      getElementById: (id: string) => elements.find((item) => item.id === id) ?? null,
      createElement: () => ({ id: '', textContent: null }),
      head: {
        appendChild: (element: { id: string; textContent: string | null }) =>
          elements.push(element),
      },
    };
    applyWebSelectionTheme(doc);
    applyWebSelectionTheme(doc);
    expect(elements).toEqual([{ id: WEB_SELECTION_STYLE_ID, textContent: WEB_SELECTION_CSS }]);
    expect(WEB_SELECTION_CSS).not.toMatch(/blue/i);
  });

  it('does nothing on native', () => {
    platformRef.value = 'ios';
    const appendChild = jest.fn();
    applyWebSelectionTheme({
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: null }),
      head: { appendChild },
    });
    expect(appendChild).not.toHaveBeenCalled();
  });
});
