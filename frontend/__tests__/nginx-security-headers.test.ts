import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from '@jest/globals';

const NGINX_CONF_PATH = resolve(__dirname, '..', 'nginx.conf');
const nginxConf = readFileSync(NGINX_CONF_PATH, 'utf-8');

/**
 * Required security headers that must appear in the nginx config.
 * Each entry maps a header name to a substring that must appear in its value.
 */
const REQUIRED_HEADERS: Array<[string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=()'],
];

describe('nginx.conf security headers', () => {
  it.each(REQUIRED_HEADERS)('includes %s header with value containing "%s"', (header, value) => {
    const pattern = new RegExp(
      `add_header\\s+${header}\\s+"[^"]*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"\\s+always`,
    );
    expect(nginxConf).toMatch(pattern);
  });

  it('includes Content-Security-Policy-Report-Only header', () => {
    expect(nginxConf).toMatch(
      /add_header\s+Content-Security-Policy-Report-Only\s+"[^"]+"\s+always/,
    );
  });

  it('CSP report-only header includes default-src directive', () => {
    const cspMatch = nginxConf.match(
      /add_header\s+Content-Security-Policy-Report-Only\s+"([^"]+)"/,
    );
    expect(cspMatch).not.toBeNull();
    expect(cspMatch![1]).toContain("default-src 'self'");
  });

  it('CSP report-only header includes script-src directive', () => {
    const cspMatch = nginxConf.match(
      /add_header\s+Content-Security-Policy-Report-Only\s+"([^"]+)"/,
    );
    expect(cspMatch).not.toBeNull();
    expect(cspMatch![1]).toContain("script-src 'self'");
  });

  it('CSP report-only header includes frame-ancestors none', () => {
    const cspMatch = nginxConf.match(
      /add_header\s+Content-Security-Policy-Report-Only\s+"([^"]+)"/,
    );
    expect(cspMatch).not.toBeNull();
    expect(cspMatch![1]).toContain("frame-ancestors 'none'");
  });

  describe('location blocks with add_header inherit security headers', () => {
    // nginx does not inherit server-level add_header directives into location
    // blocks that define their own add_header. Verify each such block repeats
    // the security headers.
    const locationBlocks = [...nginxConf.matchAll(/location\s+[^{]+\{([^}]+)\}/g)];
    const blocksWithAddHeader = locationBlocks.filter(
      (m): m is RegExpExecArray & { 1: string } =>
        m[1] !== undefined && /add_header\s+Cache-Control/.test(m[1]),
    );

    it('finds location blocks that use add_header', () => {
      expect(blocksWithAddHeader.length).toBeGreaterThan(0);
    });

    it.each(['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy'])(
      'every location block with Cache-Control also includes %s',
      (header) => {
        for (const [, body] of blocksWithAddHeader) {
          expect(body).toMatch(new RegExp(`add_header\\s+${header}\\s+`));
        }
      },
    );
  });
});
