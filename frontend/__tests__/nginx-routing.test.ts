import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from '@jest/globals';

const NGINX_CONF_PATH = resolve(__dirname, '..', 'nginx.conf');
const nginxConf = readFileSync(NGINX_CONF_PATH, 'utf-8');

const CATCH_ALL_INDEX = nginxConf.search(/location\s+\/\s*\{/);

/**
 * Extract the body of the first location block whose selector matches the
 * given regex source. Returns the raw text between the braces, or null.
 */
const locationBody = (selectorSource: string): string | null => {
  const blockPattern = new RegExp(`location\\s+~\\*\\s+${selectorSource}\\s*\\{([^}]*)\\}`);
  const match = nginxConf.match(blockPattern);
  if (!match) {
    return null;
  }
  return match[1] ?? null;
};

const blockStartIndex = (selectorSource: string): number =>
  nginxConf.search(new RegExp(`location\\s+~\\*\\s+${selectorSource}\\s*\\{`));

describe('nginx.conf vulnerability-scanner probe paths', () => {
  it('has a location block matching wp-content/wp-admin/wp-includes', () => {
    expect(blockStartIndex('\\^/\\(wp-content\\|wp-admin\\|wp-includes\\)')).toBeGreaterThanOrEqual(
      0,
    );
  });

  it('returns 404 for the wp-* probe location block', () => {
    const body = locationBody('\\^/\\(wp-content\\|wp-admin\\|wp-includes\\)');
    expect(body).not.toBeNull();
    expect(body).toMatch(/return\s+404\s*;/);
  });

  it('has a location block matching any .php request', () => {
    expect(blockStartIndex('\\\\\\.php\\$')).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 for the .php probe location block', () => {
    const body = locationBody('\\\\\\.php\\$');
    expect(body).not.toBeNull();
    expect(body).toMatch(/return\s+404\s*;/);
  });

  it('finds the SPA catch-all location block', () => {
    expect(CATCH_ALL_INDEX).toBeGreaterThanOrEqual(0);
  });

  it('places the wp-* probe block before the SPA catch-all', () => {
    const index = blockStartIndex('\\^/\\(wp-content\\|wp-admin\\|wp-includes\\)');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(CATCH_ALL_INDEX);
  });

  it('places the .php probe block before the SPA catch-all', () => {
    const index = blockStartIndex('\\\\\\.php\\$');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(CATCH_ALL_INDEX);
  });

  it('preserves the SPA fallback to index.html for extension-less routes', () => {
    expect(nginxConf).toMatch(/location\s+\/\s*\{[^}]*try_files\s+\$uri\s+\$uri\/\s+\/index\.html/);
  });
});
