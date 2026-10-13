import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from '@jest/globals';

import { answer, parseNginxConf, type Header } from '../e2e/nginxEmulator';

/**
 * The CSP browser journey serves the exported build through this emulation of
 * `nginx.conf`, so the journey only proves what production does if the
 * emulation answers the way nginx would. These cases pin it to the real conf.
 */
const plan = parseNginxConf(readFileSync(resolve(__dirname, '..', 'nginx.conf'), 'utf8'));

const BUNDLE = '/_expo/static/js/web/index-abc.js';
const FILES = new Set(['/index.html', BUNDLE, '/favicon.ico', '/metadata.json']);
const exists = (file: string): boolean => FILES.has(file);

function header(headers: readonly Header[], name: string): string | undefined {
  return headers.find(([key]) => key === name)?.[1];
}

describe('nginx.conf emulation', () => {
  it.each(['/', '/journal', '/settings/api-key', '/index.html'])(
    'answers the document route %s with index.html and its own location headers',
    (uri) => {
      const result = answer(plan, uri, exists);
      expect(result).toMatchObject({ status: 200, file: '/index.html' });
      expect(header(result.headers, 'Cache-Control')).toBe('no-store, no-cache, must-revalidate');
      expect(header(result.headers, 'Content-Security-Policy')).toContain("script-src 'self'");
    },
  );

  it('serves a fingerprinted bundle from the asset location, with its cache headers', () => {
    const result = answer(plan, BUNDLE, exists);
    expect(result).toMatchObject({ status: 200, file: BUNDLE });
    expect(header(result.headers, 'Cache-Control')).toBe('public, immutable');
    expect(header(result.headers, 'X-Frame-Options')).toBe('DENY');
  });

  it('answers a missing asset 404 rather than falling back to the SPA', () => {
    expect(answer(plan, '/_expo/static/js/web/gone.js', exists).status).toBe(404);
  });

  it('serves a plain file through try_files with the server-level headers', () => {
    const result = answer(plan, '/metadata.json', exists);
    expect(result).toMatchObject({ status: 200, file: '/metadata.json' });
    expect(header(result.headers, 'Cache-Control')).toBeUndefined();
    expect(header(result.headers, 'Content-Security-Policy')).toContain("default-src 'self'");
  });

  it.each(['/wp-admin/setup.php', '/wp-content/x', '/xmlrpc.php'])(
    'answers the scanner probe %s with 404',
    (uri) => {
      expect(answer(plan, uri, exists)).toMatchObject({ status: 404, file: null });
    },
  );
});
