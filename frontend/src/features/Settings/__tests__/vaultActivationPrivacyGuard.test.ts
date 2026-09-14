/* global describe, it, expect */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    ]);

    expect(sources).not.toMatch(
      /AsyncStorage|SecureStore|analytics\.|track\(|console\.|Sentry|captureException/u,
    );
  });

  it('ships no ordinary-Fly ceremony or recovery-material implementation', () => {
    expect(existsSync(join(FRONTEND_SOURCE, 'features/Settings/keyCeremony.ts'))).toBe(false);
    expect(existsSync(join(FRONTEND_SOURCE, 'features/Settings/saveRecoveryKey.ts'))).toBe(false);
  });

  it('names provider-managed navigation without the stronger private-vault claim', () => {
    const navigation = read([
      join(FRONTEND_SOURCE, 'navigation/RootStack.tsx'),
      join(FRONTEND_SOURCE, 'features/Settings/PrivateVaultActivationScreen.tsx'),
    ]);

    expect(navigation).toContain("options={{ title: 'Managed vault' }}");
    expect(navigation).toContain("options={{ title: 'Create managed vault' }}");
    expect(navigation).toContain('from Managed vault settings');
    expect(navigation).not.toMatch(
      /title: 'Private vault'|title: 'Create private vault'|from Private Vault settings/u,
    );
  });

  it('keeps activation controls out of signup and social auth', () => {
    const authSources = read(sourceFilesUnder(join(FRONTEND_SOURCE, 'features/Auth')));

    expect(authSources).not.toMatch(/VaultActivation|PrivateVaultActivation/u);
  });
});
