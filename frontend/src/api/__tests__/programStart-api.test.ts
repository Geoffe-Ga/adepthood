/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, stages } from '../index';
import type { ProgramCalendar } from '../index';

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

const PICKED_DAY = '2026-10-29';

const CALENDAR: ProgramCalendar = {
  program_started_at: '2026-10-29T04:00:00Z',
  calendar_stage: 1,
  calendar_week: 2,
  current_stage: 1,
  cycle_number: 1,
  program_start_window: { earliest: '2026-02-20', latest: '2026-11-08' },
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('stages.setProgramStart (#3097)', () => {
  test('PUTs exactly {program_start_date} to /stages/program-calendar', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CALENDAR));

    await stages.setProgramStart(PICKED_DAY);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/stages/program-calendar');
    expect(init.method).toBe('PUT');
    // A date and only a date: no stage field may ride along.
    expect(JSON.parse(String(init.body))).toEqual({ program_start_date: PICKED_DAY });
  });

  test('returns the parsed calendar with its window', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CALENDAR));

    const result = await stages.setProgramStart(PICKED_DAY);

    expect(result.program_started_at).toBe(CALENDAR.program_started_at);
    expect(result.program_start_window).toEqual({ earliest: '2026-02-20', latest: '2026-11-08' });
  });

  test('accepts a null window (cycle 2 and later)', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...CALENDAR, program_start_window: null }));

    const result = await stages.setProgramStart(PICKED_DAY);

    expect(result.program_start_window).toBeNull();
  });

  test('rejects a malformed window with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(
      jsonResponse({ ...CALENDAR, program_start_window: { earliest: 7 } }),
    );

    await expect(stages.setProgramStart(PICKED_DAY)).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('stages.programCalendar window', () => {
  test('parses the window the GET offers', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(CALENDAR));

    const result = await stages.programCalendar();

    expect(result.program_start_window?.latest).toBe('2026-11-08');
  });
});

describe('stages.openPass (#3728)', () => {
  const FUTURE_DAY = '2026-12-01';
  const PENDING: ProgramCalendar = {
    ...CALENDAR,
    days_until_start: 0,
    pending_pass_starts_on: FUTURE_DAY,
    pass_start_window: { earliest: '2026-10-29', latest: '2027-07-18' },
  };

  test('POSTs exactly {start_day} to /stages/passes', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(PENDING, 201));

    await stages.openPass(FUTURE_DAY);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/stages/passes');
    expect(init.method).toBe('POST');
    // The server forbids extra fields: a day and nothing else.
    expect(JSON.parse(String(init.body))).toEqual({ start_day: FUTURE_DAY });
  });

  test('returns the calendar with the pending pass, countdown and pass window', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(PENDING, 201));

    const result = await stages.openPass(FUTURE_DAY);

    expect(result.pending_pass_starts_on).toBe(FUTURE_DAY);
    expect(result.days_until_start).toBe(0);
    expect(result.pass_start_window).toEqual({ earliest: '2026-10-29', latest: '2027-07-18' });
  });

  test('rejects a negative countdown with ApiValidationError', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...PENDING, days_until_start: -1 }, 201));

    await expect(stages.openPass(FUTURE_DAY)).rejects.toBeInstanceOf(ApiValidationError);
  });
});
