/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, IDEMPOTENCY_KEY_HEADER, mettaReturn } from '../index';
import type { MettaReturnState, ReturnArc, ReturnWeek } from '../index';

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
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('mettaReturn.state', () => {
  test('GETs /metta-return and parses the full shape', async () => {
    const payload: MettaReturnState = { eligible: true, weeks: fiveWeeks(), arc: null };
    mockFetch.mockReturnValueOnce(jsonResponse(payload));
    const result = await mettaReturn.state('tok');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://test/metta-return');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result.eligible).toBe(true);
    expect(result.weeks).toHaveLength(5);
    expect(result.arc).toBeNull();
  });

  test('parses an active arc when present', async () => {
    const payload: MettaReturnState = {
      eligible: true,
      weeks: fiveWeeks(),
      arc: arc({ week: 3, focus: 'stranger' }),
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
