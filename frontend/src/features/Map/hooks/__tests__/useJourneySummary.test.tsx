/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import { renderHook } from '@testing-library/react-native';

const mockDerivedWeek = jest.fn() as jest.Mock;
jest.mock('../../../../store/useProgramProgression', () => ({
  useDerivedCurrentWeek: (...args: unknown[]) => mockDerivedWeek(...args),
}));

import { cycleLabel } from '../../beginAgain';
import { journeyRead } from '../../journeyNarrative';
import { STAGE_COUNT } from '../../stageData';
import { useJourneySummary } from '../useJourneySummary';

beforeEach(() => {
  mockDerivedWeek.mockReset();
});

describe('useJourneySummary', () => {
  it('reads the shared journey sentence from the derived current week', () => {
    mockDerivedWeek.mockReturnValue(14);
    const { result } = renderHook(() => useJourneySummary(3, 1));

    expect(result.current.read).toBe(journeyRead(3, 14, STAGE_COUNT));
  });

  it('derives the week with a fallback of 1', () => {
    mockDerivedWeek.mockReturnValue(1);
    renderHook(() => useJourneySummary(1, 1));

    expect(mockDerivedWeek).toHaveBeenCalledWith(1);
  });

  it('omits the cycle caption on the first pass through the arc', () => {
    mockDerivedWeek.mockReturnValue(1);
    const { result } = renderHook(() => useJourneySummary(2, 1));

    expect(result.current.cycleCaption).toBeNull();
  });

  it('captions the cycle past the first pass', () => {
    mockDerivedWeek.mockReturnValue(5);
    const { result } = renderHook(() => useJourneySummary(4, 3));

    expect(result.current.cycleCaption).toBe(cycleLabel(3));
  });
});
