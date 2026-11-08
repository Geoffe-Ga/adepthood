import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CORRUPT_HELD_PROGRAM_STARTS,
  VALID_HELD_PROGRAM_STARTS,
  writeRawHeldProgramStart,
} from '../../testing/corruptHeldProgramStarts';
import {
  clearPendingProgramStart,
  loadPendingProgramStart,
  savePendingProgramStart,
} from '../pendingProgramStart';

const mockReportDiagnostic = jest.fn();
jest.mock('@/observability/diagnostics', () => ({
  reportDiagnostic: (...args: unknown[]) => mockReportDiagnostic(...args),
}));

/**
 * The held first pick (#3097) is replayed to the server by the next session,
 * so whatever this module reads back is sent as the person's chosen start
 * date. These pin the read directly (#3708): a record it wrote round-trips,
 * and anything else -- whichever guard it trips -- reads back as no pick.
 */
beforeEach(async () => {
  await AsyncStorage.clear();
  mockReportDiagnostic.mockReset();
});

describe('pendingProgramStart', () => {
  it('reads back nothing when no pick is held', async () => {
    await expect(loadPendingProgramStart()).resolves.toBeNull();
    expect(mockReportDiagnostic).not.toHaveBeenCalled();
  });

  it.each(VALID_HELD_PROGRAM_STARTS)('round-trips $label', async ({ held }) => {
    await savePendingProgramStart(held);

    await expect(loadPendingProgramStart()).resolves.toEqual(held);
    expect(mockReportDiagnostic).not.toHaveBeenCalled();
  });

  it('forgets the pick once cleared', async () => {
    await savePendingProgramStart(VALID_HELD_PROGRAM_STARTS[1]!.held);

    await clearPendingProgramStart();

    await expect(loadPendingProgramStart()).resolves.toBeNull();
  });

  it.each(CORRUPT_HELD_PROGRAM_STARTS)(
    'reads $label back as no pick',
    async ({ raw, unreadable }) => {
      await writeRawHeldProgramStart(raw);

      await expect(loadPendingProgramStart()).resolves.toBeNull();
      // Only a read that failed outright is reported; a foreign shape is simply
      // not this module's record.
      expect(mockReportDiagnostic.mock.calls).toEqual(
        unreadable ? [['storage_read_failed', { storage: 'program' }]] : [],
      );
    },
  );

  it('reads a storage failure as no pick and reports it', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk gone'));

    await expect(loadPendingProgramStart()).resolves.toBeNull();
    expect(mockReportDiagnostic.mock.calls).toEqual([
      ['storage_read_failed', { storage: 'program' }],
    ]);
  });
});
