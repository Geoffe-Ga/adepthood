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
