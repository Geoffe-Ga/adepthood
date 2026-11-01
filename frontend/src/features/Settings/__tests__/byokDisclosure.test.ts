/* eslint-env jest */
/* global describe, test, expect */
import * as fs from 'fs';
import * as path from 'path';

import {
  BYOK_DETAIL_DISCLOSURE,
  BYOK_HUB_DISCLOSURE,
  BYOK_STORED_COPY_DISCLOSURE,
} from '../byokDisclosure';

import { REPO_ROOT, readBackendSource } from '@/testing/backendSource';

const PRIVACY_POLICY = path.join(REPO_ROOT, 'docs', 'legal', 'privacy-policy.md');
const TERMS = path.join(REPO_ROOT, 'docs', 'legal', 'terms-of-service.md');
const FRONTEND_API = path.join(REPO_ROOT, 'frontend', 'src', 'api', 'index.ts');
const FRONTEND_CONFIG = path.join(REPO_ROOT, 'frontend', 'src', 'config.ts');
const API_KEY_CONTEXT = path.join(REPO_ROOT, 'frontend', 'src', 'context', 'ApiKeyContext.tsx');
const SETTINGS_SCREEN = path.join(
  REPO_ROOT,
  'frontend',
  'src',
  'features',
  'Settings',
  'ApiKeySettingsScreen.tsx',
);

function prose(file: string): string {
  return fs.readFileSync(file, 'utf-8').toLowerCase().split(/\s+/).join(' ');
}

describe('the BYOK disclosure follows the key across both service boundaries', () => {
  test.each([
    ['Settings hub', BYOK_HUB_DISCLOSURE],
    ['API-key screen', BYOK_DETAIL_DISCLOSURE],
    ['privacy policy', prose(PRIVACY_POLICY)],
    ['terms', prose(TERMS)],
  ])('%s names local storage, HTTPS transit, Adepthood, and the model provider', (_name, copy) => {
    expect(copy).toMatch(/device/i);
    expect(copy).toMatch(/https/i);
    expect(copy).toMatch(/adepthood/i);
    expect(copy).toMatch(/provider/i);
  });

  test("the hub row is the owner's 2026-10-14 wording, and the detail copy carries it (#3260)", () => {
    expect(BYOK_HUB_DISCLOSURE).toBe(
      "Kept on your device. Page reading sends it from this device straight to the AI provider you chose, which sees your device's IP address. " +
        'Other features send it over HTTPS through Adepthood to that provider, only when a feature uses it.',
    );
    expect(BYOK_DETAIL_DISCLOSURE.startsWith(BYOK_HUB_DISCLOSURE)).toBe(true);
  });

  test('no user-facing source repeats the absolute never-upload claim', () => {
    const copy = [
      BYOK_HUB_DISCLOSURE,
      BYOK_DETAIL_DISCLOSURE,
      prose(PRIVACY_POLICY),
      prose(TERMS),
    ].join(' ');

    expect(copy).not.toMatch(/never upload/i);
    expect(BYOK_DETAIL_DISCLOSURE).toMatch(/without a managed vault, adepthood does not persist/i);
    expect(prose(PRIVACY_POLICY)).toMatch(/never persisted/i);
  });

  test('the stored copy kept for a managed vault is disclosed as operator-readable (R1-1)', () => {
    expect(BYOK_DETAIL_DISCLOSURE).toContain(BYOK_STORED_COPY_DISCLOSURE);
    expect(BYOK_STORED_COPY_DISCLOSURE).toMatch(/keeps one encrypted copy of your key/i);
    expect(BYOK_STORED_COPY_DISCLOSURE).toMatch(/adepthood can technically read it/i);
    expect(BYOK_STORED_COPY_DISCLOSURE).toMatch(/removing or replacing your key here deletes it/i);
    // The unqualified promise is gone from the screen: it is now false for a
    // managed vault's writer.
    expect(BYOK_DETAIL_DISCLOSURE).not.toMatch(
      /(?<!managed vault, )adepthood does not persist it/i,
    );
    expect(prose(PRIVACY_POLICY)).toContain('adepthood keeps one encrypted copy of your key');
  });

  test('removing or replacing the key deletes the server copy first (R1-1)', () => {
    const screen = fs.readFileSync(SETTINGS_SCREEN, 'utf-8');
    const api = fs.readFileSync(FRONTEND_API, 'utf-8');

    expect(api).toContain("'/user/vault-classification-key', { method: 'DELETE', token }");
    expect(screen.match(/await forgetVaultCopy\(\)/g)?.length).toBe(2);
  });
});

describe('the BYOK disclosure is constrained by the implementation', () => {
  test('production transport to Adepthood is HTTPS and carries the named header', () => {
    const config = fs.readFileSync(FRONTEND_CONFIG, 'utf-8');
    const api = fs.readFileSync(FRONTEND_API, 'utf-8');

    expect(config).toContain("!isDev && !url.startsWith('https://')");
    // The header name is stated once, in the client's request-header
    // vocabulary, and the exported constant derives from it; both halves are
    // pinned so neither can drift out from under this disclosure.
    expect(api).toContain("llmApiKey: 'X-LLM-API-Key'"); // pragma: allowlist secret
    expect(api).toContain('LLM_API_KEY_HEADER = REQUEST_HEADER_VOCABULARY.llmApiKey');
    expect(api.match(/headers: byokHeaders\(apiKey\)/g)?.length).toBeGreaterThan(0);
  });

  test('the backend accepts that header and forwards its value without persisting it', () => {
    const journal = readBackendSource('src', 'routers', 'journal.py');
    const transcription = readBackendSource('src', 'routers', 'transcription.py');
    const llm = readBackendSource('src', 'services', 'botmason.py');

    expect(journal).toContain('Header(alias="X-LLM-API-Key"');
    // Page reading no longer crosses Adepthood with the key (ADR 0009 phase (a),
    // #3067): the device calls the vendor itself, and the disclosure says so
    // (#3260).
    expect(transcription).not.toContain('X-LLM-API-Key"');
    expect(llm).toContain('return _validated_header_key(header_value)');
    expect(llm.match(/key = _resolve_api_key\(api_key\)/g)?.length).toBe(2);
    expect(llm).toContain('never persisted, logged, or echoed back');
  });

  test('the device-storage implementation comment does not contradict the transit contract', () => {
    const context = fs.readFileSync(API_KEY_CONTEXT, 'utf-8');

    expect(context).not.toContain('it lives only on the device');
    expect(context).toContain('transmitted to Adepthood');
  });
});
