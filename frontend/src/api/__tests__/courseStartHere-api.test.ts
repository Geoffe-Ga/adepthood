/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { ApiValidationError, course } from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;
jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));
beforeEach(() => mockFetch.mockReset());
function reply(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}
describe('the confirmed Start Here contract', () => {
  test('reads caller-scoped progress from its own endpoint', async () => {
    const progress = { total_items: 2, read_items: 1, progress_percent: 50, next_unlock_day: null };
    mockFetch.mockReturnValueOnce(reply(progress));
    await expect(course.startHereProgress('tok')).resolves.toEqual(progress);
    expect(mockFetch.mock.calls[0][0]).toBe('http://test/course/start-here/progress');
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });
  test('rejects a catalog without actual order and read marks', async () => {
    mockFetch.mockReturnValueOnce(
      reply([{ slug: 'about', title: 'About', description: '', url: 'content://about' }]),
    );
    await expect(course.siteResources('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
  test('rejects impossible progress rather than inferring completion', async () => {
    mockFetch.mockReturnValueOnce(
      reply({ total_items: 2, read_items: 3, progress_percent: 100, next_unlock_day: null }),
    );
    await expect(course.startHereProgress('tok')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
