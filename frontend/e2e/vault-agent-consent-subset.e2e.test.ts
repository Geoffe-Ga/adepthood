import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';
import {
  accessClaims,
  authorizeQuery,
  decide,
  openConsent,
  pkcePair,
  registerAgent,
  tokenRequest,
  type AgentProfile,
} from './vaultAgentFlow';

import { auth, setTokenGetter, vault } from '@/api';

/** Explicit consent choices narrow every permission that crosses the wire (#3544). */
const PROFILE: AgentProfile = {
  name: 'An agent asking for everything',
  registeredRedirect: 'http://127.0.0.1/callback',
  presentedRedirect: 'http://127.0.0.1:40212/callback',
  scope: 'vault:read vault:desk vault:journal vault:pipeline offline_access',
  expectedHost: '127.0.0.1',
};
const HTTP_OK = 200;
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const VAULT_API_KEY = 'e2e-vault-credential'; // pragma: allowlist secret

describe('vault.agent-consent-subset against a live server', () => {
  afterAll(() => setTokenGetter(null));
  it('shares only the choices the person checks, even when every grant was requested', async () => {
    const signup = await auth.signup({
      email: `e2e-subset-${randomUUID()}@example.com`,
      password: PASSWORD,
      timezone: 'UTC',
      license_key: freshLicenseKey(),
    });
    setTokenGetter(() => signup.token);
    const connection = await vault.connect({
      vault_url: 'https://1.1.1.1',
      api_key: VAULT_API_KEY,
    });
    const ownResource = String(connection.mcp_address);
    const profile = {
      ...PROFILE,
      name: 'An agent asking for everything',
      scope: 'vault:read vault:desk vault:journal vault:pipeline offline_access',
    };
    const agentId = await registerAgent(profile);
    const proof = pkcePair();
    const page = await openConsent(
      authorizeQuery(profile, agentId, ownResource, proof.challenge, randomUUID()),
      signup.token,
    );
    const checkboxes = page.html.match(/<input[^>]+type="checkbox"[^>]*>/gu) ?? [];
    const checked = checkboxes.filter((input) => /\schecked(?:\s|>)/u.test(input));
    expect(checked).toHaveLength(2);
    expect(checked.join(' ')).toContain('name="grant.vault:read"');
    expect(checked.join(' ')).toContain('name="grant.vault:desk"');

    // The person unchecks drafting too, leaving only reading approved.
    const back = await decide(page.ticket, 'approve', ['vault:read']);
    const exchange = await tokenRequest({
      grant_type: 'authorization_code',
      code: String(back.searchParams.get('code')),
      code_verifier: proof.verifier,
      client_id: agentId,
      redirect_uri: profile.presentedRedirect,
      resource: ownResource,
    });
    expect(exchange.status).toBe(HTTP_OK);
    const body = (await exchange.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe('vault:read');
    expect(accessClaims(body.access_token).scope).toBe('vault:read');
    expect(body).not.toHaveProperty('refresh_token');
    const agents = await vault.agents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.grants).toEqual(['vault:read']);
    await vault.revokeAgent(Number(agents[0]?.id));
  });
});
