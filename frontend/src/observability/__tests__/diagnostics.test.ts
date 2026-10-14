import { jest, describe, beforeEach, afterEach, it, expect } from '@jest/globals';

import { diagnosticRoute, reportDiagnostic, safeDiagnosticRequestId } from '../diagnostics';

describe('closed client diagnostics', () => {
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('drops unknown fields, arbitrary IDs and prose while retaining bounded operational fields', () => {
    reportDiagnostic('api_server_error', {
      route: '/journal/',
      status: 503,
      count: 999999,
      requestId: 'private-note',
      message: 'private note',
      error: new Error('private note'),
    } as never);
    expect(warn).toHaveBeenCalledWith('api_server_error', {
      route: '/journal/',
      status: 503,
      count: 10000,
    });
  });
  it('never executes accessors, including alternating approved/private values', () => {
    const getter = jest.fn().mockReturnValueOnce('auth').mockReturnValue('private note');
    reportDiagnostic(
      'storage_read_failed',
      Object.defineProperty({}, 'storage', { get: getter }) as never,
    );
    expect(getter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('storage_read_failed');
  });
  it('contains hostile proxies without disrupting the recovery caller', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('private note');
        },
      },
    );
    expect(() => reportDiagnostic('storage_read_failed', hostile)).not.toThrow();
    expect(warn).toHaveBeenCalledWith('storage_read_failed');
  });
  it('rejects nonfinite counters and unknown codes', () => {
    reportDiagnostic('private note' as never, { count: Infinity, status: NaN, attempt: -1 });
    expect(warn).toHaveBeenCalledWith('diagnostic_input_rejected');
  });
  it('keeps only UUID4 correlation IDs, including the backend generated hex form', () => {
    const hex = '11111111111141118111111111111111';
    expect(safeDiagnosticRequestId(hex)).toBe(hex);
    expect(safeDiagnosticRequestId('11111111-1111-4111-8111-111111111111')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    for (const value of [
      'private-note',
      'journal_entry_123',
      '11111111111111118111111111111111',
      {},
      null,
    ]) {
      expect(safeDiagnosticRequestId(value)).toBeUndefined();
    }
  });
  it('maps numeric resource paths to templates and discards private queries and unknown paths', () => {
    expect(diagnosticRoute('/journal/123/notes?search=private')).toBe('/journal/{entry_id}/notes');
    expect(diagnosticRoute('/habits/42/stats?name=private')).toBe('/habits/{habit_id}/stats');
    expect(diagnosticRoute('/journal/?search=private')).toBe('/journal/');
    expect(diagnosticRoute('/private note')).toBe('unknown_route');
  });
});
