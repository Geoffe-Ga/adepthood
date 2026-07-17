/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, IDEMPOTENCY_KEY_HEADER, mettaReturn } from '../index';
import type { MettaReturnState, ReleasedHabit, ReturnArc, ReturnWeek } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function week(overrides: Partial<ReturnWeek> = {}): ReturnWeek {
  return {
    week_number: 1,
    focus: 'self',
    title: 'Toward yourself',
    framing: 'Begin where you already are.',
    ...overrides,
  };
}

function fiveWeeks(): ReturnWeek[] {
  return [
    week({ week_number: 1, focus: 'self', title: 'Self' }),
    week({ week_number: 2, focus: 'benefactor', title: 'Benefactor' }),
    week({ week_number: 3, focus: 'stranger', title: 'Stranger' }),
    week({ week_number: 4, focus: 'antagonist', title: 'Antagonist' }),
    week({ week_number: 5, focus: 'all_beings', title: 'All beings' }),
  ];
}

function arc(overrides: Partial<ReturnArc> = {}): ReturnArc {
  return {
    started_at: '2026-06-24T00:00:00Z',
    paused: false,
    week: 1,
    focus: 'self',
    complete: false,
    ...overrides,
  };
}

function state(overrides: Partial<MettaReturnState> = {}): MettaReturnState {
  return {
    eligible: true,
    weeks: fiveWeeks(),
    arc: null,
    offer_dismissed: false,
    released_habits: [],
    ...overrides,
  };
}

function releasedHabit(overrides: Partial<ReleasedHabit> = {}): ReleasedHabit {
  return { habit_id: 1, name: 'Morning pages', icon: '📓', recommitted: false, ...overrides };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('mettaReturn.state', () => {
  test('GETs /metta-return and parses the full shape', async () => {
    const payload: MettaReturnState = state();
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.state('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result.eligible).toBe(true);
    expect(result.weeks).toHaveLength(5);
    expect(result.arc).toBeNull();
    expect(result.offer_dismissed).toBe(false);
  });

  test('rejects a payload missing the required offer_dismissed field via Zod', async () => {
    const payload = { eligible: true, weeks: fiveWeeks(), arc: null };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('parses a valid payload that includes offer_dismissed true', async () => {
    const payload: MettaReturnState = state({ offer_dismissed: true });
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.state('tok');
    expect(result.offer_dismissed).toBe(true);
  });

  test('parses an active arc when present', async () => {
    const payload: MettaReturnState = {
      eligible: true,
      weeks: fiveWeeks(),
      arc: arc({ week: 3, focus: 'stranger' }),
      offer_dismissed: false,
      released_habits: [],
    };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.state('tok');

    expect(result.arc?.week).toBe(3);
    expect(result.arc?.focus).toBe('stranger');
  });

  test('rejects a malformed payload missing a required field via Zod', async () => {
    const { eligible: _omit, ...withoutEligible } = { eligible: true, weeks: [], arc: null };
    void _omit;
    mockFetch.mockReturnValueOnce(jsonResponse(withoutEligible));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a bad focus enum value via Zod', async () => {
    const payload = {
      eligible: true,
      weeks: [week({ focus: 'not-a-real-focus' as ReturnWeek['focus'] })],
      arc: null,
    };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects an out-of-range week_number via Zod', async () => {
    const payload = { eligible: true, weeks: [week({ week_number: 6 })], arc: null };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a zero week_number via Zod', async () => {
    const payload = { eligible: true, weeks: [week({ week_number: 0 })], arc: null };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a zero arc week via Zod', async () => {
    const payload = { eligible: true, weeks: fiveWeeks(), arc: arc({ week: 0 }) };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects an over-bound arc week via Zod', async () => {
    const payload = { eligible: true, weeks: fiveWeeks(), arc: arc({ week: 6 }) };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects an arc payload missing the required complete field via Zod', async () => {
    const fullArc = arc();
    const { complete: _omit, ...withoutComplete } = fullArc as ReturnArc & { complete: boolean };
    void _omit;
    const payload = { eligible: true, weeks: fiveWeeks(), arc: withoutComplete };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('parses released_habits on the state payload', async () => {
    const payload = state({
      released_habits: [releasedHabit({ habit_id: 5, name: 'Cold plunge', recommitted: true })],
    });
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.state('tok');
    expect(result.released_habits).toEqual([
      releasedHabit({ habit_id: 5, name: 'Cold plunge', recommitted: true }),
    ]);
  });

  test('released_habits is empty when no arc has ever released a habit', async () => {
    const payload = state({ released_habits: [] });
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.state('tok');
    expect(result.released_habits).toEqual([]);
  });

  test('rejects a state payload with a malformed released_habits entry via Zod', async () => {
    const { icon: _omit, ...withoutIcon } = releasedHabit();
    void _omit;
    const payload = { ...state(), released_habits: [withoutIcon] };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    await expect(mettaReturn.state('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('mettaReturn.start', () => {
  test('POSTs /metta-return/arc with a deterministic idempotency key', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(arc()));
    await mettaReturn.start('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/arc');
    expect(init.method).toBe('POST');
    expect(init.headers[IDEMPOTENCY_KEY_HEADER]).toBe('start-return');
  });

  test('the idempotency key is stable across repeated calls', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(arc())).mockReturnValueOnce(jsonResponse(arc()));
    await mettaReturn.start('tok');
    await mettaReturn.start('tok');
    const calls = mockFetch.mock.calls as [string, { headers: Record<string, string> }][];
    const keys = calls.map((c) => c[1].headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys).toEqual(['start-return', 'start-return']);
  });

  test('resolves to week 1, focus self', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(arc({ week: 1, focus: 'self', paused: false })));
    const result = await mettaReturn.start('tok');
    expect(result.week).toBe(1);
    expect(result.focus).toBe('self');
    expect(result.paused).toBe(false);
  });
});

describe('mettaReturn.pause', () => {
  test('POSTs /metta-return/arc/pause and returns the paused arc', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(arc({ paused: true })));
    const result = await mettaReturn.pause('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/arc/pause');
    expect(init.method).toBe('POST');
    expect(result.paused).toBe(true);
  });
});

describe('mettaReturn.resume', () => {
  test('POSTs /metta-return/arc/resume and returns the resumed arc', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(arc({ paused: false })));
    const result = await mettaReturn.resume('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/arc/resume');
    expect(init.method).toBe('POST');
    expect(result.paused).toBe(false);
  });
});

describe('mettaReturn.leave', () => {
  test('POSTs /metta-return/arc/leave and returns the arc', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(arc()));
    const result = await mettaReturn.leave('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/arc/leave');
    expect(init.method).toBe('POST');
    expect(result.week).toBe(1);
  });
});

describe('mettaReturn.dismissOffer', () => {
  test('POSTs /metta-return/offer/dismiss and returns the full dismissed state', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(state({ offer_dismissed: true })));
    const result = await mettaReturn.dismissOffer('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/offer/dismiss');
    expect(init.method).toBe('POST');
    expect(result.offer_dismissed).toBe(true);
  });
});

describe('mettaReturn.release', () => {
  test('POSTs /metta-return/arc/release with the chosen habit ids and parses ReleasedHabit[]', async () => {
    const payload = [releasedHabit({ habit_id: 3, name: 'Cold plunge', recommitted: false })];
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.release([3], 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/arc/release');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ habit_ids: [3] });
    expect(result).toEqual(payload);
  });

  test('sends every chosen habit id in a single request', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse([
        releasedHabit({ habit_id: 1 }),
        releasedHabit({ habit_id: 2, name: 'Evening walk' }),
      ]),
    );
    await mettaReturn.release([1, 2], 'tok');

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ habit_ids: [1, 2] });
  });

  test('rejects a malformed ReleasedHabit entry via Zod', async () => {
    const { recommitted: _omit, ...withoutRecommitted } = releasedHabit();
    void _omit;
    mockFetch.mockReturnValueOnce(jsonResponse([withoutRecommitted]));
    await expect(mettaReturn.release([3], 'tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('mettaReturn.recommit', () => {
  test('POSTs /metta-return/arc/recommit with the chosen habit ids and parses ReleasedHabit[]', async () => {
    const payload = [releasedHabit({ habit_id: 3, recommitted: true })];
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.recommit([3], 'tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return/arc/recommit');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ habit_ids: [3] });
    expect(result).toEqual(payload);
  });

  test('rejects a malformed ReleasedHabit entry via Zod', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([{ habit_id: 3, name: 'Cold plunge' }]));
    await expect(mettaReturn.recommit([3], 'tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
