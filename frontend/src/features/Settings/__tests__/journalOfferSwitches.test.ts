import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  LINK_HABIT_NUDGE_SWITCH,
  MORNING_PAGES_SWITCH,
  WRITING_OFFER_SWITCH,
} from '../journalOfferSwitches';

const mockLoadAnswered = jest.fn<() => Promise<boolean>>();
const mockSaveAnswered = jest.fn<(_value: boolean) => Promise<void>>();
const mockLoadTipState =
  jest.fn<() => Promise<{ setAsideOn: string | null; neverOffer: boolean }>>();
const mockRestoreTip = jest.fn<() => Promise<boolean>>();
const mockSaveTipNeverOffer = jest.fn<(_value: boolean) => Promise<boolean>>();
const mockLoadNudgeDeclined = jest.fn<() => Promise<boolean>>();
const mockRestoreNudge = jest.fn<() => Promise<boolean>>();
const mockSaveNudgeDeclined = jest.fn<() => Promise<boolean>>();

jest.mock('@/storage/writingOfferStorage', () => ({
  loadWritingOfferAnswered: () => mockLoadAnswered(),
  saveWritingOfferAnswered: (value: boolean) => mockSaveAnswered(value),
}));
jest.mock('@/storage/morningPagesTipStorage', () => ({
  loadMorningPagesTipState: () => mockLoadTipState(),
  restoreMorningPagesTip: () => mockRestoreTip(),
  saveMorningPagesTipNeverOffer: (value: boolean) => mockSaveTipNeverOffer(value),
}));
jest.mock('@/storage/linkHabitNudgeStorage', () => ({
  loadLinkHabitNudgeDeclined: () => mockLoadNudgeDeclined(),
  restoreLinkHabitNudge: () => mockRestoreNudge(),
  saveLinkHabitNudgeDeclined: () => mockSaveNudgeDeclined(),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * Each flag is stored the other way up from the switch that shows it. These
 * pin the inversion, so a switch can never show "offered" for a decline.
 */
describe('journalOfferSwitches — the writing offer', () => {
  it('reads "offered" as the opposite of "answered"', async () => {
    mockLoadAnswered.mockResolvedValueOnce(true);
    await expect(WRITING_OFFER_SWITCH.read()).resolves.toBe(false);
    mockLoadAnswered.mockResolvedValueOnce(false);
    await expect(WRITING_OFFER_SWITCH.read()).resolves.toBe(true);
  });

  it('writes the answer the other way up, and resolves whether it landed', async () => {
    mockSaveAnswered.mockResolvedValueOnce(undefined);
    await expect(WRITING_OFFER_SWITCH.write(true)).resolves.toBe(true);
    expect(mockSaveAnswered).toHaveBeenCalledWith(false);

    mockSaveAnswered.mockResolvedValueOnce(undefined);
    await expect(WRITING_OFFER_SWITCH.write(false)).resolves.toBe(true);
    expect(mockSaveAnswered).toHaveBeenLastCalledWith(true);
  });

  it('a failed write resolves false and warns, rather than rejecting into the switch', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSaveAnswered.mockRejectedValueOnce(new Error('quota'));

    await expect(WRITING_OFFER_SWITCH.write(true)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('journalOfferSwitches — morning pages', () => {
  it('reads "offered" from the permanent decline only, never from a day set aside', async () => {
    mockLoadTipState.mockResolvedValueOnce({ setAsideOn: '2026-10-02', neverOffer: false });
    await expect(MORNING_PAGES_SWITCH.read()).resolves.toBe(true);
    mockLoadTipState.mockResolvedValueOnce({ setAsideOn: null, neverOffer: true });
    await expect(MORNING_PAGES_SWITCH.read()).resolves.toBe(false);
  });

  it('on restores the tip; off declines it for good; each hands back whether it saved', async () => {
    mockRestoreTip.mockResolvedValueOnce(false);
    await expect(MORNING_PAGES_SWITCH.write(true)).resolves.toBe(false);
    expect(mockSaveTipNeverOffer).not.toHaveBeenCalled();

    mockSaveTipNeverOffer.mockResolvedValueOnce(true);
    await expect(MORNING_PAGES_SWITCH.write(false)).resolves.toBe(true);
    expect(mockSaveTipNeverOffer).toHaveBeenCalledWith(true);
    expect(mockRestoreTip).toHaveBeenCalledTimes(1);
  });
});

describe('journalOfferSwitches — the link-a-habit note', () => {
  it('reads "offered" as the opposite of "declined"', async () => {
    mockLoadNudgeDeclined.mockResolvedValueOnce(true);
    await expect(LINK_HABIT_NUDGE_SWITCH.read()).resolves.toBe(false);
    mockLoadNudgeDeclined.mockResolvedValueOnce(false);
    await expect(LINK_HABIT_NUDGE_SWITCH.read()).resolves.toBe(true);
  });

  it('on restores the note; off records the decline; each hands back whether it saved', async () => {
    mockRestoreNudge.mockResolvedValueOnce(true);
    await expect(LINK_HABIT_NUDGE_SWITCH.write(true)).resolves.toBe(true);
    expect(mockSaveNudgeDeclined).not.toHaveBeenCalled();

    mockSaveNudgeDeclined.mockResolvedValueOnce(false);
    await expect(LINK_HABIT_NUDGE_SWITCH.write(false)).resolves.toBe(false);
    expect(mockRestoreNudge).toHaveBeenCalledTimes(1);
  });
});
