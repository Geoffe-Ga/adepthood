import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';
import {
  accessClaims,
  authorizeQuery,
  decide,
  exchangeCode,
  openConsent,
  pkcePair,
  refreshTokens,
  registerAgent,
  type AgentProfile,
  type AgentTokens,
} from './vaultAgentFlow';

import { auth, setTokenGetter, vault, type ConnectedAgent } from '@/api';
import { AGENT_GRANT_PHRASES } from '@/features/Settings/agentsCopy';

/**
 * OpenClaw approved, listed and stopped -- across the wire (#3534).
 *
 * OpenClaw (2026.3.31 and later) speaks streamable HTTP with `auth: "oauth"`: it
 * registers itself with a loopback redirect, listens on a port it picks per
 * sign-in, and opens the person's browser at the consent page.
 *
 * The person's half runs through the production client: the address Settings
 * shows (`GET /vault/connection`'s `mcp_address`) is the resource the agent asks
 * for, the agent appears under "Agents that may read your vault" with its
 * permissions in the same words the consent page used, and Stop
 * (`DELETE /vault/agents/{id}`) refuses the agent's next refresh.
 *
 * What this lane cannot drive is the draft itself: that call goes to the vault's
 * `/mcp` endpoint, and the lane's vault is a contract fake of `/v1` with no MCP
 * surface. The token's audience and agent are asserted instead, which is what
 * the vault verifies before it runs a tool (Creek-Vault#1963).
 */

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
// An address literal: connecting stores it without a lookup, so the lane needs
// no DNS, and its MCP address is what the agent names as its resource.
const VAULT_URL = 'https://1.1.1.1';
const VAULT_API_KEY = 'e2e-vault-credential'; // pragma: allowlist secret
const HTTP_BAD_REQUEST = 400;

const PROFILE: AgentProfile = {
  name: 'OpenClaw',
  registeredRedirect: 'http://127.0.0.1/oauth/callback',
  presentedRedirect: 'http://127.0.0.1:47613/oauth/callback',
  scope: 'vault:read vault:desk offline_access',
  expectedHost: '127.0.0.1',
};

const email = `e2e-agent-openclaw-${randomUUID()}${EMAIL_DOMAIN}`;
const state = randomUUID();
const pkce = pkcePair();

describe('vault.agent-approve-draft-revoke for OpenClaw, against a live server', () => {
  let sessionToken: string | null = null;
  let resource = '';
  let clientId = '';
  let code = '';
  let tokens: AgentTokens | null = null;
  let listed: ConnectedAgent | undefined;

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account and connects a vault the agent can be pointed at', async () => {
    const signup = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    sessionToken = signup.token;
    setTokenGetter(() => sessionToken);

    const connection = await vault.connect({ vault_url: VAULT_URL, api_key: VAULT_API_KEY });

    expect(connection.mcp_address).toBe(`${VAULT_URL}/mcp`);
    resource = String(connection.mcp_address);
    expect((await vault.connection()).mcp_address).toBe(resource);
  });

  it('lists no agent before one is approved', async () => {
    expect(await vault.agents()).toEqual([]);
  });

  it('is approved on the consent page, in the words Settings will use', async () => {
    clientId = await registerAgent(PROFILE);
    const page = await openConsent(
      authorizeQuery(PROFILE, clientId, resource, pkce.challenge, state),
      String(sessionToken),
    );

    for (const scope of PROFILE.scope.split(' ')) {
      expect(page.html).toContain(String(AGENT_GRANT_PHRASES.get(scope)));
    }
    const back = await decide(page.ticket, 'approve');

    expect(`${back.origin}${back.pathname}`).toBe(PROFILE.presentedRedirect);
    expect(back.searchParams.get('state')).toBe(state);
    code = String(back.searchParams.get('code'));
    expect(code).not.toBe('null');
  });

  it('trades its code for a token naming this vault and this agent', async () => {
    tokens = await exchangeCode(PROFILE, clientId, code, pkce.verifier, resource);
    const claims = accessClaims(tokens.accessToken);

    expect(claims.aud).toBe(resource);
    expect(claims.client_id).toBe(clientId);
    expect(String(claims.scope).split(' ')).toEqual(PROFILE.scope.split(' '));
  });

  it('appears under Agents that may read your vault, used and with its grants', async () => {
    const agents = await vault.agents();
    listed = agents.find((agent) => agent.name === PROFILE.name);

    expect(agents).toHaveLength(1);
    expect(listed?.grants).toEqual(PROFILE.scope.split(' '));
    expect(listed?.redirect_host).toBe(PROFILE.expectedHost);
    expect(listed?.last_used_at).not.toBeNull();
  });

  it('is stopped from Settings, and its next refresh is refused', async () => {
    await vault.revokeAgent(Number(listed?.id));

    const refresh = await refreshTokens(clientId, String(tokens?.refreshToken));

    expect(refresh.status).toBe(HTTP_BAD_REQUEST);
    expect(await refresh.json()).toEqual({ error: 'invalid_grant' });
    expect(await vault.agents()).toEqual([]);
  });
});
