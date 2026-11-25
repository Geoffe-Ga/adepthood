import { describe, expect, it } from '@jest/globals';

import { NAMING_RULES, findForbiddenNames } from './userFacingNaming.test';

/**
 * The "vault" row of the naming guard, held against a violating fixture
 * (#3804).
 *
 * Settings says "your Corpus" wherever it said "vault", and the row added to
 * `NAMING_RULES` for it has to tell copy from the tokens that keep the word:
 * test IDs (`vault-agent-row-`), routes (`VaultSettings`), agent scopes
 * (`vault:read`), refusal codes (`vault_url_malformed`) and the export format
 * (`'vault'`). A plain `/vault/i` would flag every one of those; this proves
 * the pattern flags the sentences and nothing else.
 */

const SETTINGS_VAULT_RULE = 'vault (Settings)';

function vaultPattern(): RegExp {
  const rule = NAMING_RULES.find((candidate) => candidate.name === SETTINGS_VAULT_RULE);
  if (!rule) throw new Error(`NAMING_RULES has no "${SETTINGS_VAULT_RULE}" row any more.`);
  return rule.pattern;
}

// Every shape Settings copy took when it said the word.
const VIOLATING = `
export const VAULT_DASHBOARD_TITLE = 'Your vault';
export const VAULT_NONE_CONNECTED = 'No vault connected yet.';
export const VAULT_SHAPE_HEADING = "Your vault's shape";
const opening = 'Managed vaults are opening gradually';
const waiting = 'Waiting for room to open up for your vault…';
const landed = \`\${count} items from your vault\`;
const label = 'Create managed vault';
const placeholder = 'https://your-vault.example';
const heading = 'Vault settings';
`;

const VIOLATING_JSX = `
export const Offer = () => (
  <View accessibilityLabel="Continue managed vault setup">
    <Text>
      Adepthood will set up a vault just for your account.
    </Text>
    <TextInput placeholder="Your vault address" />
  </View>
);
`;

// Everywhere the word stays: nothing here is read by a user.
const INTERNAL_ONLY = `
// A vault is an optional depth, in a comment.
import { vault } from '@/api';
type ExportFormat = 'json' | 'markdown' | 'vault';
const run = () => exportAs('vault');
const scopes = new Map([['vault:read', 'Read and search your Open and Personal writing']]);
const refusals = { vault_url_malformed: VAULT_ADDRESS_INCOMPLETE };
const code = 'vault_url_unresolvable_host';
navigation.navigate('VaultSettings');
navigation.navigate(first ? 'VaultDashboard' : 'VaultActivation');
const landed = receipt.vault_status === 'accepted';
`;

const INTERNAL_ONLY_JSX = `
export const Row = ({ id }) => (
  <View testID={\`vault-agent-row-\${id}\`}>
    <Pressable testID="vault-confirm-cancel" />
  </View>
);
`;

describe('the Settings "vault" rule', () => {
  it('flags the word in headings, sentences, plurals, possessives and templates', () => {
    expect(findForbiddenNames('fixture.ts', VIOLATING, vaultPattern())).toEqual([
      '2: Your vault',
      '3: No vault connected yet.',
      "4: Your vault's shape",
      '5: Managed vaults are opening gradually',
      '6: Waiting for room to open up for your vault…',
      '7: items from your vault',
      '8: Create managed vault',
      '9: https://your-vault.example',
      '10: Vault settings',
    ]);
  });

  it('flags the word in JSX text, accessibility labels and placeholders', () => {
    expect(findForbiddenNames('fixture.tsx', VIOLATING_JSX, vaultPattern())).toEqual([
      '3: Continue managed vault setup',
      '5: Adepthood will set up a vault just for your account.',
      '7: Your vault address',
    ]);
  });

  it('leaves comments, identifiers, routes, scopes, refusal codes and the export format alone', () => {
    expect(findForbiddenNames('fixture.ts', INTERNAL_ONLY, vaultPattern())).toEqual([]);
  });

  it('leaves test IDs alone, templated or plain', () => {
    expect(findForbiddenNames('fixture.tsx', INTERNAL_ONLY_JSX, vaultPattern())).toEqual([]);
  });

  it('covers Settings and nothing beside it', () => {
    const rule = NAMING_RULES.find((candidate) => candidate.name === SETTINGS_VAULT_RULE);

    expect(rule?.scope).toEqual(['features/Settings']);
  });
});
