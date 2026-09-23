import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { copyToClipboard } from '../clipboard';

const originalNavigator = globalThis.navigator;

function withClipboard(writeText: ((_v: string) => Promise<void>) | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: writeText ? { writeText } : undefined },
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true });
});

describe('copyToClipboard', () => {
  it('writes through navigator.clipboard and reports success', async () => {
    const writeText = jest.fn<(_v: string) => Promise<void>>().mockResolvedValue(undefined);
    withClipboard(writeText);

    expect(await copyToClipboard('draft')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('draft');
  });

  it('reports failure when the write is refused', async () => {
    withClipboard(jest.fn<(_v: string) => Promise<void>>().mockRejectedValue(new Error('denied')));
    expect(await copyToClipboard('draft')).toBe(false);
  });

  it('reports failure when there is no clipboard', async () => {
    withClipboard(undefined);
    expect(await copyToClipboard('draft')).toBe(false);
  });
});
