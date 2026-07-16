/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { PracticeItem, UserPractice } from '@/api';

const practiceWithMode: PracticeItem = {
  id: 5,
  stage_number: 2,
  name: 'Steady breath',
  description: 'A short reset.',
  instructions: 'Breathe in for four, out for six.',
  default_duration_minutes: 5,
  submitted_by_user_id: null,
  approved: true,
  mode: 'meditation_timer',
  mode_config: { mode: 'meditation_timer', duration_minutes: 5 },
};

const createdDraft: PracticeItem = {
  ...practiceWithMode,
  id: 501,
  stage_number: 6,
  approved: false,
  submitted_by_user_id: 9,
};

const assignedUserPractice: UserPractice = {
  id: 1,
  user_id: 9,
  practice_id: 501,
  stage_number: 6,
  start_date: '2026-07-15',
  end_date: null,
};

const mockPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: Record<string, unknown>) => Promise<PracticeItem>
>;
const mockUserPracticesCreate = jest.fn() as jest.MockedFunction<
  (payload: { practice_id: number; stage_number: number }) => Promise<UserPractice>
>;

jest.mock('@/api', () => ({
  practices: {
    create: (...args: unknown[]) =>
      (mockPracticesCreate as unknown as (...a: unknown[]) => Promise<PracticeItem>)(...args),
  },
  userPractices: {
    create: (...args: unknown[]) =>
      (mockUserPracticesCreate as unknown as (...a: unknown[]) => Promise<UserPractice>)(...args),
  },
}));

const { copyPracticeToStage } = require('../copyPracticeToStage');

describe('copyPracticeToStage', () => {
  beforeEach(() => {
    mockPracticesCreate.mockReset();
    mockUserPracticesCreate.mockReset();
  });

  it('creates a draft copy at the target stage with the name unchanged', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    await copyPracticeToStage(practiceWithMode, 6);
    expect(mockPracticesCreate).toHaveBeenCalledWith({
      stage_number: 6,
      name: 'Steady breath',
      description: practiceWithMode.description,
      instructions: practiceWithMode.instructions,
      default_duration_minutes: practiceWithMode.default_duration_minutes,
      mode: practiceWithMode.mode,
      mode_config: practiceWithMode.mode_config,
    });
    const [payload] = mockPracticesCreate.mock.calls[0] as [{ name: string }];
    expect(payload.name).not.toContain('(copy)');
  });

  it('assigns the created draft at the target stage after creating it', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    await copyPracticeToStage(practiceWithMode, 6);
    expect(mockUserPracticesCreate).toHaveBeenCalledWith({ practice_id: 501, stage_number: 6 });
  });

  it('awaits the create call before issuing the assign call', async () => {
    const order: string[] = [];
    mockPracticesCreate.mockImplementationOnce(async () => {
      order.push('create');
      return createdDraft;
    });
    mockUserPracticesCreate.mockImplementationOnce(async () => {
      order.push('assign');
      return assignedUserPractice;
    });
    await copyPracticeToStage(practiceWithMode, 6);
    expect(order).toEqual(['create', 'assign']);
  });

  it('resolves with the created draft', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    const result = await copyPracticeToStage(practiceWithMode, 6);
    expect(result).toBe(createdDraft);
  });

  it('never calls userPractices.create and rejects when practices.create rejects', async () => {
    mockPracticesCreate.mockRejectedValueOnce(new Error('create failed'));
    await expect(copyPracticeToStage(practiceWithMode, 6)).rejects.toThrow('create failed');
    expect(mockUserPracticesCreate).not.toHaveBeenCalled();
  });

  it('rejects after create ran when userPractices.create rejects', async () => {
    mockPracticesCreate.mockResolvedValueOnce(createdDraft);
    mockUserPracticesCreate.mockRejectedValueOnce(new Error('assign failed'));
    await expect(copyPracticeToStage(practiceWithMode, 6)).rejects.toThrow('assign failed');
    expect(mockPracticesCreate).toHaveBeenCalledTimes(1);
  });

  it('omits mode and mode_config from the create payload when the source practice has neither', async () => {
    const noModePractice: PracticeItem = {
      ...practiceWithMode,
      mode: undefined,
      mode_config: undefined,
    };
    mockPracticesCreate.mockResolvedValueOnce(createdDraft);
    mockUserPracticesCreate.mockResolvedValueOnce(assignedUserPractice);
    await copyPracticeToStage(noModePractice, 6);
    const [payload] = mockPracticesCreate.mock.calls[0] as [Record<string, unknown>];
    expect('mode' in payload).toBe(false);
    expect('mode_config' in payload).toBe(false);
  });
});
