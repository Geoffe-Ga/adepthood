import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { CourseSession } from '../courseSession';
import { loadInitialReadingStage } from '../initialReadingStage';

import { stages, uiFlags, type CourseProgress, type Stage } from '@/api';

jest.mock('@/api', () => ({
  stages: { programCalendar: jest.fn() },
  uiFlags: { get: jest.fn() },
}));

const session: CourseSession = {
  token: 'captured-token',
  owner: 1,
  generation: 0,
  current: jest.fn(() => true),
};
const available = [{ stage_number: 5, is_unlocked: true }] as Stage[];
const unread: CourseProgress = {
  total_items: 2,
  read_items: 0,
  progress_percent: 0,
  next_unlock_day: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(session.current).mockReturnValue(true);
  jest
    .mocked(uiFlags.get)
    .mockResolvedValue({ course_last_stage: 5 } as Awaited<ReturnType<typeof uiFlags.get>>);
  jest
    .mocked(stages.programCalendar)
    .mockResolvedValue({ current_stage: 2 } as Awaited<ReturnType<typeof stages.programCalendar>>);
});
describe('the Course entry selection', () => {
  it('puts unread Start Here before a saved higher Frequency', async () => {
    await expect(loadInitialReadingStage(available, null, unread, null, session)).resolves.toBe(0);
    expect(uiFlags.get).not.toHaveBeenCalled();
  });
  it('preserves an explicit stage route while Start Here is unread', async () => {
    await expect(loadInitialReadingStage(available, null, unread, 2, session)).resolves.toBe(2);
  });
  it('keeps the available last-read Frequency once every resource is read', async () => {
    await expect(
      loadInitialReadingStage(available, null, { ...unread, read_items: 2 }, null, session),
    ).resolves.toBe(5);
  });
  it('does not treat an empty catalog as unfinished', async () => {
    await expect(
      loadInitialReadingStage(available, null, { ...unread, total_items: 0 }, null, session),
    ).resolves.toBe(5);
  });
  it('falls back to the calendar when the saved Frequency is locked', async () => {
    await expect(
      loadInitialReadingStage([], null, { ...unread, read_items: 2 }, null, session),
    ).resolves.toBe(2);
  });
  it('passes the initiating credential to flags and the calendar', async () => {
    await loadInitialReadingStage([], null, { ...unread, read_items: 2 }, null, session);
    expect(uiFlags.get).toHaveBeenCalledWith(session.token);
    expect(stages.programCalendar).toHaveBeenCalledWith(session.token);
  });
  it('drops a held flags response before starting a calendar request', async () => {
    jest.mocked(uiFlags.get).mockImplementationOnce(async () => {
      jest.mocked(session.current).mockReturnValue(false);
      return { course_last_stage: null } as Awaited<ReturnType<typeof uiFlags.get>>;
    });
    await expect(
      loadInitialReadingStage([], null, { ...unread, read_items: 2 }, null, session),
    ).rejects.toThrow('Course session changed');
    expect(stages.programCalendar).not.toHaveBeenCalled();
  });
  it('drops a held calendar response after the initiating session changes', async () => {
    jest.mocked(stages.programCalendar).mockImplementationOnce(async () => {
      jest.mocked(session.current).mockReturnValue(false);
      return { current_stage: 2 } as Awaited<ReturnType<typeof stages.programCalendar>>;
    });
    await expect(
      loadInitialReadingStage([], null, { ...unread, read_items: 2 }, null, session),
    ).rejects.toThrow('Course session changed');
  });
  it('does not infer completion from a failed progress request', async () => {
    // Unknown progress opens Start Here, where the failed read is reported (#3344).
    await expect(loadInitialReadingStage(available, null, null, null, session)).resolves.toBe(0);
    expect(uiFlags.get).not.toHaveBeenCalled();
    await expect(loadInitialReadingStage(available, null, null, 2, session)).resolves.toBe(2);
  });
});
