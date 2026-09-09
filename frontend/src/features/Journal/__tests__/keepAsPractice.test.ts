/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import { GREEN_STAGE_NUMBER, keepAsPractice, planKeepAsPractice } from '../keepAsPractice';

import { practiceSessions, practices, stages, userPractices } from '@/api';

jest.mock('@/api', () => ({
  practices: { listAll: jest.fn() },
  userPractices: { list: jest.fn(), create: jest.fn() },
  practiceSessions: { create: jest.fn() },
  stages: { programCalendar: jest.fn() },
}));

const listCatalogue = practices.listAll as jest.Mock;
const listSelections = userPractices.list as jest.Mock;
const createSelection = userPractices.create as jest.Mock;
const createSession = practiceSessions.create as jest.Mock;
const programCalendar = stages.programCalendar as jest.Mock;

const JOURNALING_ID = 41;
const OTHER_PRACTICE_ID = 42;
const SELECTION_ID = 900;
const TWENTY_MINUTES_MS = 20 * 60 * 1000;
const ENDED_AT = new Date('2026-09-08T09:20:00.000Z');
const SESSION = { endedAt: ENDED_AT, elapsedMs: TWENTY_MINUTES_MS };

function catalogueRow(id: number, name: string) {
  return {
    id,
    stage_number: GREEN_STAGE_NUMBER,
    name,
    description: 'd',
    instructions: 'i',
    default_duration_minutes: 20,
    approved: true,
    mode: 'count_up',
  };
}

function selection(overrides: Record<string, unknown> = {}) {
  return {
    id: SELECTION_ID,
    practice_id: OTHER_PRACTICE_ID,
    stage_number: GREEN_STAGE_NUMBER,
    start_date: '2026-01-01',
    end_date: null,
    effective_name: 'Loving-kindness',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  listCatalogue.mockImplementation(() =>
    Promise.resolve([
      catalogueRow(OTHER_PRACTICE_ID, 'Shadow Drawing'),
      catalogueRow(JOURNALING_ID, 'Journaling'),
    ]),
  );
  listSelections.mockImplementation(() => Promise.resolve([]));
  programCalendar.mockImplementation(() => Promise.resolve({ current_stage: GREEN_STAGE_NUMBER }));
  createSelection.mockImplementation(() => Promise.resolve({ id: SELECTION_ID }));
  createSession.mockImplementation(() => Promise.resolve({ id: 1 }));
});

describe('planKeepAsPractice — what the writer would be agreeing to', () => {
  it('finds the seeded Journaling row at Green, with nothing in the way', async () => {
    const plan = await planKeepAsPractice();

    expect(plan).toEqual({ practiceId: JOURNALING_ID, displaces: null, waitingAt: null });
    expect(listCatalogue).toHaveBeenCalledWith({ stageNumber: GREEN_STAGE_NUMBER });
  });

  it('names the open selection Journaling would displace', async () => {
    listSelections.mockImplementation(() => Promise.resolve([selection()]));

    expect((await planKeepAsPractice())?.displaces).toBe('Loving-kindness');
  });

  it('does not call a closed selection at Green a displacement', async () => {
    listSelections.mockImplementation(() =>
      Promise.resolve([selection({ end_date: '2026-02-01' })]),
    );

    expect((await planKeepAsPractice())?.displaces).toBeNull();
  });

  it('does not call an open selection at another stage a displacement', async () => {
    listSelections.mockImplementation(() => Promise.resolve([selection({ stage_number: 3 })]));

    expect((await planKeepAsPractice())?.displaces).toBeNull();
  });

  it('does not displace Journaling with itself', async () => {
    listSelections.mockImplementation(() =>
      Promise.resolve([selection({ practice_id: JOURNALING_ID, effective_name: 'Journaling' })]),
    );

    expect((await planKeepAsPractice())?.displaces).toBeNull();
  });

  it('names the stage the writer is at when Green is not open to them yet', async () => {
    programCalendar.mockImplementation(() => Promise.resolve({ current_stage: 1 }));

    expect((await planKeepAsPractice())?.waitingAt).toBe('Beige');
  });

  it('treats the stage below Green as not yet open, and Green itself as open', async () => {
    programCalendar.mockImplementation(() => Promise.resolve({ current_stage: 5 }));
    expect((await planKeepAsPractice())?.waitingAt).toBe('Orange');

    programCalendar.mockImplementation(() => Promise.resolve({ current_stage: 6 }));
    expect((await planKeepAsPractice())?.waitingAt).toBeNull();
  });

  it('has no plan when the catalogue has no Journaling row', async () => {
    listCatalogue.mockImplementation(() =>
      Promise.resolve([catalogueRow(OTHER_PRACTICE_ID, 'Shadow Drawing')]),
    );

    expect(await planKeepAsPractice()).toBeNull();
  });

  it('has no plan when a lookup fails, rather than guessing at one', async () => {
    listSelections.mockImplementation(() => Promise.reject(new Error('offline')));

    expect(await planKeepAsPractice()).toBeNull();
  });
});

describe('keepAsPractice — the write', () => {
  const openPlan = { practiceId: JOURNALING_ID, displaces: null, waitingAt: null };

  it('selects Journaling at Green and logs the session that has just finished', async () => {
    const outcome = await keepAsPractice(openPlan, SESSION);

    expect(createSelection).toHaveBeenCalledWith({
      practice_id: JOURNALING_ID,
      stage_number: GREEN_STAGE_NUMBER,
    });
    expect(outcome).toEqual({ kept: true, sessionLogged: true });
  });

  it('logs the session against the new selection, spanning exactly what was written', async () => {
    await keepAsPractice(openPlan, SESSION);

    const [payload] = createSession.mock.calls[0] as [
      { user_practice_id: number; started_at: string; ended_at: string },
    ];
    expect(payload.user_practice_id).toBe(SELECTION_ID);
    expect(payload.ended_at).toBe(ENDED_AT.toISOString());
    expect(Date.parse(payload.ended_at) - Date.parse(payload.started_at)).toBe(TWENTY_MINUTES_MS);
  });

  it('does not log a session against a stage the writer has not reached', async () => {
    const outcome = await keepAsPractice({ ...openPlan, waitingAt: 'Beige' }, SESSION);

    expect(createSelection).toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(outcome).toEqual({ kept: true, sessionLogged: false });
  });

  it('keeps nothing when the selection itself fails', async () => {
    createSelection.mockImplementation(() => Promise.reject(new Error('offline')));

    expect(await keepAsPractice(openPlan, SESSION)).toEqual({ kept: false, sessionLogged: false });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('still reports the practice kept when only the session log fails', async () => {
    createSession.mockImplementation(() => Promise.reject(new Error('offline')));

    expect(await keepAsPractice(openPlan, SESSION)).toEqual({ kept: true, sessionLogged: false });
  });
});
