/* global describe, it, expect, afterEach, jest */
import { Platform, Share } from 'react-native';

import { copyRecoveryKey, saveRecoveryKeyLocally } from '../saveRecoveryKey';

const RECOVERY_KEY = 'AAAAA-BBBBB-CCCCC-DDDDD';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('copyRecoveryKey', () => {
  it('copies only after the user asks and reports success', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(global, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    await expect(copyRecoveryKey(RECOVERY_KEY)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(RECOVERY_KEY);
  });

  it('reports that a clipboard is unavailable without throwing', async () => {
    Object.defineProperty(global, 'navigator', { configurable: true, value: {} });

    await expect(copyRecoveryKey(RECOVERY_KEY)).resolves.toBe(false);
  });
});

describe('saveRecoveryKeyLocally', () => {
  it('opens the native share sheet with a local text copy', async () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: Share.sharedAction, activityType: null });

    await expect(saveRecoveryKeyLocally(RECOVERY_KEY)).resolves.toBe(true);
    expect(share).toHaveBeenCalledWith({
      message: expect.stringContaining(RECOVERY_KEY),
      title: 'Adepthood private vault recovery key',
    });
  });

  it('reports a dismissed native share sheet as unsaved', async () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });

    await expect(saveRecoveryKeyLocally(RECOVERY_KEY)).resolves.toBe(false);
  });

  it('downloads a text copy on web and immediately releases its object URL', async () => {
    jest.replaceProperty(Platform, 'OS', 'web');
    const originalUrl = globalThis.URL;
    const originalDocument = globalThis.document;
    const originalBlob = globalThis.Blob;
    const click = jest.fn();
    const remove = jest.fn();
    const appendChild = jest.fn();
    const createObjectURL = jest.fn().mockReturnValue('blob:recovery');
    const revokeObjectURL = jest.fn();
    class FakeBlob {
      constructor(
        readonly parts: string[],
        readonly options: { type: string },
      ) {}
    }
    Object.defineProperty(globalThis, 'URL', {
      configurable: true,
      value: { createObjectURL, revokeObjectURL },
    });
    Object.defineProperty(globalThis, 'Blob', { configurable: true, value: FakeBlob });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({ href: '', download: '', click, remove }),
        body: { appendChild },
      },
    });

    try {
      await expect(saveRecoveryKeyLocally(RECOVERY_KEY)).resolves.toBe(true);
      expect(createObjectURL).toHaveBeenCalledWith(
        expect.objectContaining({ parts: [expect.stringContaining(RECOVERY_KEY)] }),
      );
      expect(appendChild).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery');
    } finally {
      Object.defineProperty(globalThis, 'URL', { configurable: true, value: originalUrl });
      Object.defineProperty(globalThis, 'Blob', { configurable: true, value: originalBlob });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
