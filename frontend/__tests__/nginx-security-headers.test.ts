import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from '@jest/globals';

const NGINX_CONF_PATH = resolve(__dirname, '..', 'nginx.conf');
const nginxConf = readFileSync(NGINX_CONF_PATH, 'utf-8');
/** The config with `#` comments removed, so prose about a block cannot parse as one. */
const nginxCode = nginxConf.replace(/#.*$/gm, '');

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

/** An enforced CSP header, capturing its policy; never matches the report-only name. */
const ENFORCED_CSP = /add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always/g;
const ENFORCED_CSP_ONCE = /add_header\s+Content-Security-Policy\s+"[^"]+"\s+always/;

/**
 * The placeholder `web-hardening/csp.js` replaces with the API (and, when set, the
 * Sentry) origin the bundle was built against. Unrendered, a browser drops it
 * as an invalid source, so a conf that skipped the render fails closed.
 */
const CONNECT_ORIGINS_TOKEN = '__BUILD_CONNECT_ORIGINS__';

/** Directive name to its source list, in written order. */
function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name, sources);
  }
  return directives;
}

/** Each location block's selector (e.g. `= /index.html`) mapped to its body. */
function locationBodies(): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const match of nginxCode.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)) {
    bodies.set(match[1] ?? '', match[2] ?? '');
  }
  return bodies;
}

/** The server block with every location block cut out: what locations inherit. */
function serverLevelText(): string {
  return nginxCode.replace(/location\s+[^{]+\{[^}]*\}/g, '');
}

describe('nginx.conf security headers', () => {
  it.each(REQUIRED_HEADERS)('includes %s header with value containing "%s"', (header, value) => {
    const pattern = new RegExp(
      `add_header\\s+${header}\\s+"[^"]*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"\\s+always`,
    );
    expect(nginxConf).toMatch(pattern);
  });

  describe('Content-Security-Policy is enforced (ADR 0009 phase (b))', () => {
    const policies = [...nginxCode.matchAll(ENFORCED_CSP)].map((match) => match[1] ?? '');
    const policy = parsePolicy(policies[0] ?? '');

    it('sends no report-only policy anywhere', () => {
      expect(nginxConf).not.toMatch(/Content-Security-Policy-Report-Only/);
    });

    it('sends the enforced header at the server level and at index.html', () => {
      expect(policies.length).toBeGreaterThanOrEqual(2);
      expect(serverLevelText()).toMatch(ENFORCED_CSP_ONCE);
      expect(locationBodies().get('= /index.html')).toMatch(ENFORCED_CSP_ONCE);
    });

    it('sends one policy, spelled identically at every site', () => {
      expect(new Set(policies).size).toBe(1);
    });

    it("allows scripts from 'self' only: no inline, eval, hash or host source", () => {
      expect(policy.get('script-src')).toEqual(["'self'"]);
    });

    it("permits 'unsafe-inline' for styles only, and 'unsafe-eval' nowhere", () => {
      expect(policy.size).toBeGreaterThan(0);
      for (const [directive, sources] of policy) {
        expect(sources).not.toContain("'unsafe-eval'");
        if (directive !== 'style-src') expect(sources).not.toContain("'unsafe-inline'");
      }
      expect(policy.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    });

    it.each([
      ['default-src', ["'self'"]],
      ['object-src', ["'none'"]],
      ['base-uri', ["'none'"]],
      ['form-action', ["'self'"]],
      ['frame-ancestors', ["'none'"]],
      ['font-src', ["'self'"]],
      ['media-src', ["'self'", 'data:']],
    ])('pins %s to %j', (directive, sources) => {
      expect(policy.get(directive)).toEqual(sources);
    });

    it('narrows connect-src to self, the build-time origins and the two BYOK vendors', () => {
      expect(policy.get('connect-src')).toEqual([
        "'self'",
        CONNECT_ORIGINS_TOKEN,
        'https://api.openai.com',
        'https://api.anthropic.com',
      ]);
    });

    it('lets no fetch directive fall open to a bare scheme or wildcard, except img-src', () => {
      expect(policy.size).toBeGreaterThan(0);
      for (const [directive, sources] of policy) {
        expect(sources).not.toContain('*');
        if (directive !== 'img-src') expect(sources).not.toContain('https:');
      }
    });
  });

  describe('location blocks with add_header inherit security headers', () => {
    // nginx does not inherit server-level add_header directives into location
    // blocks that define their own add_header. Verify each such block repeats
    // the security headers.
    const locationBlocks = [...nginxCode.matchAll(/location\s+[^{]+\{([^}]+)\}/g)];
    const blocksWithAddHeader = locationBlocks.filter(
      (m): m is RegExpExecArray & { 1: string } =>
        m[1] !== undefined && /add_header\s+Cache-Control/.test(m[1]),
    );

    it('finds location blocks that use add_header', () => {
      expect(blocksWithAddHeader.length).toBeGreaterThan(0);
    });

    it.each([
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Content-Security-Policy',
    ])('every location block with Cache-Control also includes %s', (header) => {
      for (const [, body] of blocksWithAddHeader) {
        expect(body).toMatch(new RegExp(`add_header\\s+${header}\\s+"`));
      }
    });
  });
});
