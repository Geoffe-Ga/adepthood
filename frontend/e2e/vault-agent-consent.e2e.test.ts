import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from '@jest/globals';

import { freshLicenseKey } from './licenseKey';
import {
  authorizeQuery,
  consentFrom,
  decide,
  pkcePair,
  registerAgent,
  type AgentProfile,
} from './vaultAgentFlow';

import { auth, setTokenGetter, vault } from '@/api';
import { API_BASE_URL } from '@/config';

/**
 * The consent page an agent sends a person to, driven across the wire (#3532).
 *
 * The approve half is driven per client by the three
 * `vault.agent-approve-draft-revoke` journeys. This one drives the rest of the
 * page: a person with no app session in that browser signs in on the page
 * itself, reads the floor, and declines -- the agent is sent back
 * `access_denied` and nothing is listed under Settings. And an agent naming
 * somebody else's vault as its resource is refused `invalid_target` before any
 * page is drawn, for both accounts.
 */

const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const VAULT_API_KEY = 'e2e-vault-credential'; // pragma: allowlist secret
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const CONSENT_FLOOR = 'Intimate entries are never included.';

const PROFILE: AgentProfile = {
  name: 'A consent-page agent',
  registeredRedirect: 'http://127.0.0.1/callback',
  presentedRedirect: 'http://127.0.0.1:40111/callback',
  scope: 'vault:read',
  expectedHost: '127.0.0.1',
};

const email = `e2e-consent-${randomUUID()}${EMAIL_DOMAIN}`;
const neighbourEmail = `e2e-consent-neighbour-${randomUUID()}${EMAIL_DOMAIN}`;
const state = randomUUID();
const pkce = pkcePair();

/** Sign up through the production client and make the account the current one. */
async function signUp(address: string): Promise<string> {
  const response = await auth.signup({
    email: address,
    password: PASSWORD,
    timezone: TIMEZONE,
    license_key: freshLicenseKey(),
  });
  return response.token;
}

describe('vault.agent-consent-page against a live server', () => {
  let ownToken: string | null = null;
  let neighbourToken: string | null = null;
  let ownResource = '';
  let neighbourResource = '';
  let clientId = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('gives two accounts a vault each', async () => {
    neighbourToken = await signUp(neighbourEmail);
    setTokenGetter(() => neighbourToken);
    neighbourResource = String(
      (await vault.connect({ vault_url: 'https://1.0.0.1', api_key: VAULT_API_KEY })).mcp_address,
    );

    ownToken = await signUp(email);
    setTokenGetter(() => ownToken);
    ownResource = String(
      (await vault.connect({ vault_url: 'https://1.1.1.1', api_key: VAULT_API_KEY })).mcp_address,
    );

    expect(ownResource).not.toBe(neighbourResource);
  });

  it('asks a person with no session in that browser to sign in, on the page', async () => {
    clientId = await registerAgent(PROFILE);
    const query = authorizeQuery(PROFILE, clientId, ownResource, pkce.challenge, state);

    const page = await fetch(`${API_BASE_URL}/oauth/authorize?${query.toString()}`);

    expect(page.status).toBe(HTTP_OK);
    expect(await page.text()).toContain('action="/oauth/authorize/sign-in"');
  });

  it('signs in there, states the floor, and on Decline sends the agent access_denied', async () => {
    const query = authorizeQuery(PROFILE, clientId, ownResource, pkce.challenge, state);
    query.set('email', email);
    query.set('password', PASSWORD);
    const signedIn = await fetch(`${API_BASE_URL}/oauth/authorize/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: query.toString(),
    });
    expect(signedIn.status).toBe(HTTP_OK);
    const page = consentFrom(await signedIn.text());

    expect(page.html).toContain(CONSENT_FLOOR);
    expect(page.html).toContain(PROFILE.name);
    const back = await decide(page.ticket, 'decline');

    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(state);
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('lists nothing in Settings after a decline', async () => {
    expect(await vault.agents()).toEqual([]);
  });

  it("refuses an agent naming the neighbour's vault before any page is drawn", async () => {
    const query = authorizeQuery(PROFILE, clientId, neighbourResource, pkce.challenge, state);

    const refused = await fetch(`${API_BASE_URL}/oauth/authorize?${query.toString()}`, {
      headers: { Authorization: `Bearer ${String(ownToken)}` },
      redirect: 'manual',
    });

    expect(refused.status).toBe(HTTP_BAD_REQUEST);
    const body = await refused.text();
    expect(body).toContain('invalid_target');
    expect(body).not.toContain('name="ticket"');
    expect(await vault.agents()).toEqual([]);
    setTokenGetter(() => neighbourToken);
    expect(await vault.agents()).toEqual([]);
  });
});
