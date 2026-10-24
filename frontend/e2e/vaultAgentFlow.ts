import { createHash, randomBytes } from 'node:crypto';

import { API_BASE_URL } from '@/config';

/**
 * The agent's half of connecting an agent to a vault, spoken over the wire.
 *
 * The app never makes these requests -- an agent does: it registers itself
 * (RFC 7591), sends the person's browser to the consent page, receives the code
 * on its own redirect and trades it, with its PKCE verifier, for tokens
 * (#3532, #3533). There is therefore no wrapper for them in `src/api`, and the
 * specs that use this module reach them with plain `fetch`, exactly as an agent
 * would. Everything the *person* does afterwards -- reading the agent list,
 * pressing Stop -- goes through the production client, which is the seam the
 * `vault.agent-approve-draft-revoke` journeys cross.
 *
 * Each acceptance client registers the way it does in the field, so a profile
 * names its own redirect shape: a loopback listener on an ephemeral port for a
 * program on the person's computer, an https callback for a hosted connector.
 */

/** How one acceptance client introduces itself and where it listens. */
export interface AgentProfile {
  /** The `client_name` it registers with. */
  readonly name: string;
  /** The redirect it registers. */
  readonly registeredRedirect: string;
  /** The redirect it presents on authorize, e.g. the loopback port it bound. */
  readonly presentedRedirect: string;
  /** The scopes it asks for, space-separated. */
  readonly scope: string;
  /** The host Settings should say it signs in through. */
  readonly expectedHost: string;
}

/** What a consent page put in front of the person, and the ticket behind Approve. */
export interface ConsentPage {
  readonly html: string;
  readonly ticket: string;
}

/** The tokens a code is traded for. */
export interface AgentTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_SEE_OTHER = 303;
/** 32 bytes of verifier: 43 base64url characters, the RFC 7636 minimum. */
const VERIFIER_BYTES = 32;
const TICKET = /name="ticket" value="([^"]+)"/u;
const FORM_TYPE = 'application/x-www-form-urlencoded';

/** One PKCE pair per agent sign-in, as a public client mints it. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Fail with what the server said when a step did not answer as an agent expects. */
async function expectStatus(response: Response, status: number, step: string): Promise<void> {
  if (response.status !== status) {
    throw new Error(`${step} answered ${response.status}: ${await response.text()}`);
  }
}

/** Register the agent the way `profile` does, and return its client id. */
export async function registerAgent(profile: AgentProfile): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: profile.name,
      redirect_uris: [profile.registeredRedirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  await expectStatus(response, HTTP_CREATED, 'registration');
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

/** The query an agent sends the person's browser to the consent page with. */
export function authorizeQuery(
  profile: AgentProfile,
  clientId: string,
  resource: string,
  challenge: string,
  state: string,
): URLSearchParams {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: profile.presentedRedirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: profile.scope,
    resource,
  });
}

/** Read the consent ticket out of a rendered decision page. */
export function consentFrom(html: string): ConsentPage {
  const match = TICKET.exec(html);
  if (match === null) {
    throw new Error(`the consent page carried no ticket:\n${html}`);
  }
  return { html, ticket: String(match[1]) };
}

/** Open the consent page as a person already signed in to the app. */
export async function openConsent(
  query: URLSearchParams,
  sessionToken: string,
): Promise<ConsentPage> {
  const response = await fetch(`${API_BASE_URL}/oauth/authorize?${query.toString()}`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  await expectStatus(response, HTTP_OK, 'the consent page');
  return consentFrom(await response.text());
}

/**
 * Press Approve or Decline, and return where the browser is sent back to.
 *
 * `redirect: 'manual'` keeps the 303 in hand: following it would dial the
 * agent's own listener, which in the field is the agent and here is nothing.
 */
export async function decide(ticket: string, decision: 'approve' | 'decline'): Promise<URL> {
  const response = await fetch(`${API_BASE_URL}/oauth/authorize/decision`, {
    method: 'POST',
    headers: { 'Content-Type': FORM_TYPE },
    body: new URLSearchParams({ ticket, decision }).toString(),
    redirect: 'manual',
  });
  await expectStatus(response, HTTP_SEE_OTHER, 'the decision');
  const location = response.headers.get('location');
  if (location === null) {
    throw new Error('the decision redirected nowhere');
  }
  return new URL(location);
}

/** POST a token request, form-encoded as every OAuth client sends one. */
export function tokenRequest(form: Record<string, string>): Promise<Response> {
  return fetch(`${API_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': FORM_TYPE },
    body: new URLSearchParams(form).toString(),
  });
}

/** Trade a code and its verifier for tokens, as the agent's listener does. */
export async function exchangeCode(
  profile: AgentProfile,
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
): Promise<AgentTokens> {
  const response = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: profile.presentedRedirect,
    resource,
  });
  await expectStatus(response, HTTP_OK, 'the code exchange');
  const body = (await response.json()) as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** Ask for a fresh access token the way an agent does every ten minutes. */
export function refreshTokens(clientId: string, refreshToken: string): Promise<Response> {
  return tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

/**
 * The claims of an access token, read without verifying it.
 *
 * Verification is the vault's job (Creek-Vault#1963) and needs the published
 * key set; what a journey asserts is only which vault and which agent the token
 * names.
 */
export function accessClaims(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}
