import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { act } from '@testing-library/react-native';

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(() => Promise.resolve()),
  getItem: jest.fn(() => Promise.resolve(null)),
  removeItem: jest.fn(() => Promise.resolve()),
}));

const mockAsyncStorage = jest.requireMock('@react-native-async-storage/async-storage') as {
  setItem: jest.Mock;
  getItem: jest.Mock;
  removeItem: jest.Mock;
};

describe('useProgramStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { useProgramStore } = require('../useProgramStore');
    act(() => {
      useProgramStore.getState().hydrateProgramStartDate(null);
    });
  });

  it('starts with no program start date', () => {
    const { useProgramStore } = require('../useProgramStore');
    expect(useProgramStore.getState().programStartDate).toBeNull();
  });

  it('setProgramStartDate normalises to midnight local time', () => {
    const { useProgramStore } = require('../useProgramStore');
    const evening = new Date(2026, 4, 12, 23, 45);
    act(() => useProgramStore.getState().setProgramStartDate(evening));

    const stored = useProgramStore.getState().programStartDate!;
    expect(stored.getFullYear()).toBe(2026);
    expect(stored.getMonth()).toBe(4);
    expect(stored.getDate()).toBe(12);
    expect(stored.getHours()).toBe(0);
    expect(stored.getMinutes()).toBe(0);
  });

  it('setProgramStartDate persists to AsyncStorage', async () => {
    const { useProgramStore } = require('../useProgramStore');
    act(() => useProgramStore.getState().setProgramStartDate(new Date(2026, 0, 1)));
    // Persistence is fire-and-forget; flush microtasks before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockAsyncStorage.setItem).toHaveBeenCalledWith(
      '@adepthood/program_start_date',
      '2026-01-01',
    );
  });

  it('setProgramStartDate(null) clears persisted storage', async () => {
    const { useProgramStore } = require('../useProgramStore');
    act(() => useProgramStore.getState().setProgramStartDate(null));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/program_start_date');
  });

  it('accepts past dates without throwing', () => {
    const { useProgramStore } = require('../useProgramStore');
    const past = new Date(2020, 0, 1);
    act(() => useProgramStore.getState().setProgramStartDate(past));
    expect(useProgramStore.getState().programStartDate?.getFullYear()).toBe(2020);
  });

  it('hydrateProgramStartDate sets the value without writing storage', async () => {
    const { useProgramStore } = require('../useProgramStore');
    act(() => useProgramStore.getState().hydrateProgramStartDate(new Date(2026, 5, 1)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockAsyncStorage.setItem).not.toHaveBeenCalled();
    expect(useProgramStore.getState().programStartDate?.getMonth()).toBe(5);
  });

  it('reset() clears the anchor and removes persisted storage', async () => {
    const { useProgramStore } = require('../useProgramStore');
    act(() => useProgramStore.getState().setProgramStartDate(new Date(2026, 0, 1)));
    mockAsyncStorage.removeItem.mockClear();

    act(() => useProgramStore.getState().reset());
    await new Promise((resolve) => setImmediate(resolve));

    expect(useProgramStore.getState().programStartDate).toBeNull();
    expect(mockAsyncStorage.removeItem).toHaveBeenCalledWith('@adepthood/program_start_date');
  });

  it('reset runs when resetAllStores is called', () => {
    const { useProgramStore } = require('../useProgramStore');
    const { resetAllStores } = require('../registry');
    act(() => useProgramStore.getState().setProgramStartDate(new Date(2026, 0, 1)));
    act(() => resetAllStores());
    expect(useProgramStore.getState().programStartDate).toBeNull();
  });
});

describe('programDayOffset / programWeek / programStage', () => {
  const { programDayOffset, programWeek, programStage } = require('../useProgramStore');

  it('returns null for every derived value when no anchor is set', () => {
    expect(programDayOffset(null)).toBeNull();
    expect(programWeek(null)).toBeNull();
    expect(programStage(null)).toBeNull();
  });

  it('returns 0 offset / week 1 / stage 1 on the anchor day', () => {
    const anchor = new Date(2026, 4, 12);
    expect(programDayOffset(anchor, anchor)).toBe(0);
    expect(programWeek(anchor, anchor)).toBe(1);
    expect(programStage(anchor, anchor)).toBe(1);
  });

  it('clamps a future anchor to week 1 / stage 1 (pre-program)', () => {
    const anchor = new Date(2026, 4, 20);
    const today = new Date(2026, 4, 12);
    expect(programDayOffset(anchor, today)).toBe(-8);
    expect(programWeek(anchor, today)).toBe(1);
    expect(programStage(anchor, today)).toBe(1);
  });

  it('advances week and stage as days elapse', () => {
    const anchor = new Date(2026, 0, 1);

    // Day 7 -> Week 2, still Stage 1 (21-day stage).
    expect(programWeek(anchor, new Date(2026, 0, 8))).toBe(2);
    expect(programStage(anchor, new Date(2026, 0, 8))).toBe(1);

    // Day 21 -> Week 4, Stage 2.
    expect(programWeek(anchor, new Date(2026, 0, 22))).toBe(4);
    expect(programStage(anchor, new Date(2026, 0, 22))).toBe(2);

    // Day 168 -> end of Stage 8, Stage 9 begins (24 weeks in).
    const dayInMs = 24 * 60 * 60 * 1000;
    expect(programStage(anchor, new Date(anchor.getTime() + 168 * dayInMs))).toBe(9);

    // Day 210 -> Stage 10 begins (30 weeks in).
    expect(programStage(anchor, new Date(anchor.getTime() + 210 * dayInMs))).toBe(10);
  });

  it('clamps a long-past anchor to week 36 / stage 10', () => {
    const anchor = new Date(2020, 0, 1);
    const today = new Date(2026, 4, 12);
    expect(programWeek(anchor, today)).toBe(36);
    expect(programStage(anchor, today)).toBe(10);
  });
});
