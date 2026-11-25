import { describe, expect, it } from '@jest/globals';

import { NAMING_RULES, findForbiddenNames } from './userFacingNaming.test';

/**
 * The "vault" row of the naming guard, proven against fixtures (#3805).
 *
 * `userFacingNaming.test.ts` holds the row against the real tree; this file
 * shows the row's pattern catching the word in every shape copy takes, and
 * letting through the tokens that keep it because no user reads them.
 */

const vaultRule = NAMING_RULES.find((rule) => rule.name === 'vault outside Settings');

const hits = (fileName: string, source: string): string[] => {
  if (vaultRule === undefined) throw new Error('the vault rule is missing from NAMING_RULES');
  return findForbiddenNames(fileName, source, vaultRule.pattern);
};

// A deliberately violating fixture: every shape the app's copy takes.
const VIOLATING = `
export const ROW = 'In your vault. It will show up in reflections from here on.';
const line = \`Paid by your own \${vendor} key, through your vault\`;
const body = 'Removal is requested; ' + 'they may remain until the vault confirms.';
const labels = { reconnect: 'Reconnect vault', title: 'Your vault', one: 'Vault' };
const plural = 'We are opening managed vaults gradually.';
const shout = 'VAULT';
`;

const VIOLATING_JSX = `
export const Notice = () => (
  <View accessibilityLabel="Create managed vault">
    <Text>
      Readings your vault answers use BotMason credits.
    </Text>
    <TextInput placeholder="Private vault address" />
  </View>
);
`;

// Everywhere the word stays: nothing here is read by a user.
const INTERNAL_ONLY = `
// In your vault, in a comment
import { VAULT_ROW_LABEL } from '@/features/Settings/vaultCopy';
type Destination = 'vault' | 'corpus';
const destination = z.enum(['vault', 'corpus']);
const status = 'vault_busy';
const location = 'connected_vault';
const source = 'creek_vault';
const hint = 'vaultWithdrawalPending';
const route = 'VaultDashboard';
const path = \`/vault/agents/\${id}\`;
const endpoint = '/users/me/export/vault';
const VAULT_FIRST_CTA = 'Give your writing a place to live';
`;

const INTERNAL_ONLY_JSX = `
export const Link = () => <Pressable testID="seed-vault-invitation-link" />;
`;

describe('the vault row of the naming guard', () => {
  it('covers every top-level area of src except Settings', () => {
    expect(vaultRule?.scope).toContain('features/Seed');
    expect(vaultRule?.scope).toContain('features/Journal');
    expect(vaultRule?.scope).toContain('api');
    expect(vaultRule?.scope).toContain('navigation');
    expect(vaultRule?.scope).not.toContain('features/Settings');
  });

  it('flags the word in sentences, templates, concatenations and capitalised labels', () => {
    expect(hits('fixture.ts', VIOLATING)).toEqual([
      '2: In your vault. It will show up in reflections from here on.',
      '3: key, through your vault',
      '4: they may remain until the vault confirms.',
      '5: Reconnect vault',
      '5: Your vault',
      '5: Vault',
      '6: We are opening managed vaults gradually.',
      '7: VAULT',
    ]);
  });

  it('flags the word in JSX text, accessibility props and placeholders', () => {
    expect(hits('fixture.tsx', VIOLATING_JSX)).toEqual([
      '3: Create managed vault',
      '5: Readings your vault answers use BotMason credits.',
      '7: Private vault address',
    ]);
  });

  it('leaves comments, identifiers, routes, paths, API values and test IDs alone', () => {
    expect(hits('fixture.ts', INTERNAL_ONLY)).toEqual([]);
    expect(hits('fixture.tsx', INTERNAL_ONLY_JSX)).toEqual([]);
  });
});
