import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { answer, parseNginxConf } from '../e2e/nginxEmulator';

const FRONTEND = resolve(__dirname, '..');
const SHA = 'fa30ecb307dee6b099848a209a85666ddb58b2dd'; // pragma: allowlist secret - public Git commit fixture

describe('the web build receipt', () => {
  it.each([
    [SHA, SHA],
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['fa30ecb', 'unknown'],
    [SHA.toUpperCase(), 'unknown'],
    ['release-2026-10', 'unknown'],
    [` ${SHA}`, 'unknown'],
    [`${SHA}\n`, 'unknown'],
  ])('stamps %j as %s with a closed, content-free field set', (value, release) => {
    const dist = mkdtempSync(join(tmpdir(), 'adepthood-receipt-test-'));
    try {
      const env = { ...process.env, RAILWAY_GIT_COMMIT_SHA: value };
      const result = spawnSync(process.execPath, ['web-hardening/build-receipt.js', dist], {
        cwd: FRONTEND,
        env,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(dist, 'build-receipt.json'), 'utf8'))).toEqual({
        receipt_schema: 1,
        release,
        surface: 'web',
      });
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });

  it('declares the platform SHA and stamps the exported distribution in Docker', () => {
    const docker = readFileSync(join(FRONTEND, 'Dockerfile'), 'utf8');
    expect(docker).toMatch(/^ARG RAILWAY_GIT_COMMIT_SHA$/m);
    expect(docker).toMatch(/RUN node web-hardening\/build-receipt\.js dist/);
    expect(docker.indexOf('RUN node web-hardening/build-receipt.js dist')).toBeGreaterThan(
      docker.indexOf('RUN npx expo export --platform web'),
    );
  });

  it('serves the JSON without caching and never substitutes the SPA for an absent receipt', () => {
    const conf = readFileSync(join(FRONTEND, 'nginx.conf'), 'utf8');
    const body = /location\s+=\s+\/build-receipt\.json\s*\{([^}]+)\}/.exec(conf)?.[1];
    expect(body).toBeDefined();
    expect(body).toMatch(/default_type\s+application\/json\s*;/);
    expect(body).toMatch(/add_header\s+Cache-Control\s+"no-store"\s+always\s*;/);
    expect(body).not.toContain('/index.html');
    const plan = parseNginxConf(conf);
    expect(answer(plan, '/build-receipt.json', (file) => file === '/build-receipt.json')).toEqual(
      expect.objectContaining({ status: 200, file: '/build-receipt.json' }),
    );
    const absent = answer(plan, '/build-receipt.json', (file) => file === '/index.html');
    expect(absent).toEqual(expect.objectContaining({ status: 404, file: null }));
    expect(absent.headers).toContainEqual(['Cache-Control', 'no-store']);
  });
});
