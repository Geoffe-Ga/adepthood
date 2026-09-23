/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import {
  ApiValidationError,
  feedback,
  IDEMPOTENCY_KEY_HEADER,
  type FeedbackCreate,
} from '../index';

const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

beforeEach(() => {
  mockFetch.mockReset();
});

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

const RECEIPT = {
  public_id: 'FB-7K3M9Q2B',
  category: 'broken',
  impact: 'blocked',
  created_at: '2026-09-23T10:00:00Z',
};

const REPORT: FeedbackCreate = {
  category: 'broken',
  impact: 'blocked',
  summary: 'It broke',
  context: {
    screen: 'journal.shelf',
    platform: 'web',
    app_build: '1.0.0',
    viewport_class: 'compact',
  },
};

const KEY = '8b0a3c52-2c1f-4c0e-9d1f-7a3c2b1e0f9d';

describe('feedback.submit', () => {
  test('POSTs the report with the key under IDEMPOTENCY_KEY_HEADER and returns the receipt', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(RECEIPT, 201));

    const receipt = await feedback.submit(REPORT, KEY);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/feedback/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(REPORT);
    const headers = init.headers as Record<string, string>;
    expect(headers[IDEMPOTENCY_KEY_HEADER]).toBe(KEY);
    expect(receipt).toEqual(RECEIPT);
  });

  test('the key is required at the type level', () => {
    // @ts-expect-error -- an unkeyed submit would file a new row on every retry.
    const call = () => feedback.submit(REPORT);
    expect(typeof call).toBe('function');
  });

  test('rejects a receipt whose public_id does not match the reference pattern', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...RECEIPT, public_id: 'FB-IIIIIIII' }, 201));

    await expect(feedback.submit(REPORT, KEY)).rejects.toBeInstanceOf(ApiValidationError);
  });

  test('rejects a receipt with a category outside the vocabulary', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...RECEIPT, category: 'rant' }, 201));

    await expect(feedback.submit(REPORT, KEY)).rejects.toBeInstanceOf(ApiValidationError);
  });
});

describe('feedback.receipt', () => {
  test('GETs the receipt for a reference and validates it', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse(RECEIPT));

    await expect(feedback.receipt('FB-7K3M9Q2B')).resolves.toEqual(RECEIPT);
    expect(mockFetch.mock.calls[0]?.[0]).toBe('http://test/feedback/FB-7K3M9Q2B/receipt');
  });

  test('rejects a malformed receipt', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse({ ...RECEIPT, public_id: 'nope' }));

    await expect(feedback.receipt('FB-7K3M9Q2B')).rejects.toBeInstanceOf(ApiValidationError);
  });
});
