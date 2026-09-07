/* global describe, it, expect */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FRONTEND_SOURCE = join(process.cwd(), 'src');

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFilesUnder(path);
    return /\.[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}

function read(paths: string[]): string {
  return paths.map((path) => readFileSync(path, 'utf8')).join('\n');
}

describe('private-vault activation privacy boundary', () => {
  it('keeps client secrets out of persistence, analytics, logs, and crash reporting', () => {
    const sources = read([
      join(FRONTEND_SOURCE, 'features/Settings/PrivateVaultActivationScreen.tsx'),
      join(FRONTEND_SOURCE, 'features/Settings/keyCeremony.ts'),
      join(FRONTEND_SOURCE, 'features/Settings/saveRecoveryKey.ts'),
    ]);

    expect(sources).not.toMatch(
      /AsyncStorage|SecureStore|analytics\.|track\(|console\.|Sentry|captureException/u,
    );
  });

  it('keeps activation and key-ceremony controls out of signup and social auth', () => {
    const authSources = read(sourceFilesUnder(join(FRONTEND_SOURCE, 'features/Auth')));

    expect(authSources).not.toMatch(/VaultActivation|PrivateVaultActivation|prepareKeyCeremony/u);
  });
});
