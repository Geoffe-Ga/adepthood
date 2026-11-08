/* eslint-env jest */
import { afterEach, describe, expect, it } from '@jest/globals';
import { act, renderHook } from '@testing-library/react-native';

import { STAGE_ORDER } from '@/design/tokens';
import {
  stageColorName,
  storedStageColorName,
  useStageColorName,
  useStageColorNames,
} from '@/store/stageColorName';
import { clearServedStages, serveStageColors } from '@/testing/servedStageColors';

/** A stage whose served colour the tests replace with one the fallback would not give. */
const STAGE = 1;
/** The pinned offline colour name of ``STAGE``, read rather than restated. */
const FALLBACK = STAGE_ORDER[STAGE - 1];
/** Any served colour that differs from ``FALLBACK``. */
const SERVED = 'Teal';

afterEach(() => {
  clearServedStages();
});

describe('stageColorName', () => {
  it('takes the served colour name over the pinned fallback', () => {
    expect(FALLBACK).not.toBe(SERVED);
    expect(stageColorName(STAGE, SERVED)).toBe(SERVED);
  });

  it('trims the served name', () => {
    expect(stageColorName(STAGE, `  ${SERVED} `)).toBe(SERVED);
  });

  it('reads the legacy Turquoise as its canonical Teal', () => {
    expect(stageColorName(STAGE, 'Turquoise')).toBe('Teal');
  });

  it.each([undefined, null, '', '   '])(
    'falls back to the pinned offline name when the served one is %p',
    (served) => {
      expect(stageColorName(STAGE, served)).toBe(FALLBACK);
    },
  );

  it('falls back by position for every stage the fallback names', () => {
    STAGE_ORDER.forEach((name, index) => {
      expect(stageColorName(index + 1)).toBe(name);
    });
  });

  it.each([0, STAGE_ORDER.length + 1, Number.NaN])(
    'names nothing for stage %p when nothing was served',
    (stageNumber) => {
      expect(stageColorName(stageNumber)).toBeUndefined();
    },
  );

  it('never consults the store: the explicit served value is the only served source', () => {
    serveStageColors({ [STAGE]: SERVED });
    expect(stageColorName(STAGE, undefined)).toBe(FALLBACK);
  });
});

describe('storedStageColorName', () => {
  it('reads the colour the stage store was served', () => {
    serveStageColors({ [STAGE]: SERVED });
    expect(storedStageColorName(STAGE)).toBe(SERVED);
  });

  it('falls back to the pinned name while the store is empty', () => {
    expect(storedStageColorName(STAGE)).toBe(FALLBACK);
  });

  it('falls back to the pinned name when the stored colour is blank', () => {
    serveStageColors({ [STAGE]: '' });
    expect(storedStageColorName(STAGE)).toBe(FALLBACK);
  });
});

describe('useStageColorName', () => {
  it('re-renders with the served colour once the store fills', () => {
    const { result } = renderHook(() => useStageColorName(STAGE));
    expect(result.current).toBe(FALLBACK);
    act(() => serveStageColors({ [STAGE]: SERVED }));
    expect(result.current).toBe(SERVED);
  });

  it('names nothing for no stage', () => {
    const { result } = renderHook(() => useStageColorName(null));
    expect(result.current).toBeUndefined();
  });
});

describe('useStageColorNames', () => {
  it('looks up every stage, following the store as it fills', () => {
    const { result } = renderHook(() => useStageColorNames());
    expect(STAGE_ORDER.map((_, index) => result.current(index + 1))).toEqual([...STAGE_ORDER]);
    act(() => serveStageColors({ [STAGE]: SERVED }));
    expect(result.current(STAGE)).toBe(SERVED);
    expect(result.current(STAGE_ORDER.length + 1)).toBeUndefined();
  });
});
