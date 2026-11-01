import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  ACCOUNT_PHRASE,
  backendUrl,
  bearer,
  frontendUrl,
  logIn,
} from './journalHabitsBrowserSupport';
import { freshLicenseKey } from './licenseKey';

import {
  AGENTS_EMPTY,
  AGENTS_MANAGED_ADDRESS_UNAVAILABLE,
  AGENTS_STOP,
  AGENTS_STOPPED,
} from '@/features/Settings/agentsCopy';

/**
 * A ready managed vault whose agent address cannot be confirmed (#3545, #3546).
 *
 * The allocation is made the way a person makes one: the production
 * activation routes drive the lane's protocol-shaped Creek control plane
 * (`fakeCreekServer.mjs`) through to its authenticated handoff, so the
 * account ends `ready` with a private `/v1` binding it never sees. That
 * binding answers no Creek capability document carrying `agent_mcp`, and the
 * lane's issuer is not an `https://` origin any discovery could name, so the
 * authenticated 0.24 discovery `GET /vault/connection` runs is unavailable --
 * the state every managed vault is in before its allocation reports an exact
 * resource/issuer match. Nothing on the request path is stubbed: the
 * response the screen renders is read off the wire and asserted.
 *
 * What a person must see then is the honest sentence, and nothing that
 * pretends otherwise: no address, no copy control, and no empty-state
 * invitation to approve an agent through a flow that could not be pointed
 * anywhere. An agent approved before -- through the real authorize/token
 * path, for the resource the authorization server accepts for this account --
 * stays listed with its Stop control, and Stop still ends its refresh.
 *
 * The other half of the journey -- an allocation whose discovery names its
 * own `/a/<slug>/mcp` resource, shown with a copy control -- is not driven
 * here; see `vault.managed-agent-sign-in-availability` in `journeys.json`.
 */

/** `globalSetup` enrols exactly these ids in the managed-vault pilot. */
const PILOT_ACCOUNT_IDS = 100;
/** The shared-edge resource of the fake control plane's handoff URL (`https://1.1.1.1`). */
const SHARED_EDGE_RESOURCE = 'https://1.1.1.1/mcp';
const AGENT_NAME = 'A lane agent approved before the address was known';
const AGENT_SCOPE = 'vault:read offline_access';
const REGISTERED_REDIRECT = 'http://127.0.0.1/callback';
const PRESENTED_REDIRECT = 'http://127.0.0.1:40377/callback';
/** Pending, provisioning, then the handoff: a few reads, bounded. */
const ACTIVATION_READS = 8;
const VERIFIER_BYTES = 32;
const TICKET = /name="ticket" value="([^"]+)"/u;
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_SEE_OTHER = 303;
const HTTP_BAD_REQUEST = 400;
const HTTP_NO_CONTENT = 204;
/** A phone-height viewport, as the other Settings frames use. */
const VIEWPORT_HEIGHT = 844;
const WIDTHS = [390, 1280] as const;

interface Account {
  email: string;
  token: string;
}

interface VaultActivationStatus {
  state: string;
  recovery_available: boolean;
  credential_received: boolean;
}

/** A pilot account, signed up over the real route and past the welcome. */
async function pilotAccount(request: APIRequestContext): Promise<Account> {
  const email = `managed-agent-${randomBytes(6).toString('hex')}@example.com`;
  const signup = await request.post(`${backendUrl()}/auth/signup`, {
    data: { email, password: ACCOUNT_PHRASE, timezone: 'UTC', license_key: freshLicenseKey() },
  });
  expect(signup.status()).toBe(HTTP_OK);
  const { token, user_id: userId } = (await signup.json()) as { token: string; user_id: number };
  // An id past the allowlist is refused activation, which would turn this spec
  // into one about the pilot gate. Fail naming the cause instead.
  expect(userId, 'the managed-vault pilot allowlist covers ids 1..100').toBeLessThanOrEqual(
    PILOT_ACCOUNT_IDS,
  );
  const flags = await request.patch(`${backendUrl()}/ui-flags`, {
    headers: bearer(token),
    data: { has_seen_welcome: true },
  });
  expect(flags.status()).toBe(HTTP_OK);
  return { email, token };
}

async function activationCall(
  request: APIRequestContext,
  token: string,
  method: 'get' | 'post',
  path = '',
): Promise<VaultActivationStatus> {
  const response = await request[method](`${backendUrl()}/vault/activation${path}`, {
    headers: bearer(token),
  });
  expect(response.ok(), `${method.toUpperCase()} /vault/activation${path}`).toBe(true);
  return (await response.json()) as VaultActivationStatus;
}

/**
 * Activate a managed vault and read it to `ready`.
 *
 * The fake answers the run's first activation with a terminal provider
 * rejection; whichever spec meets it recovers, exactly as a person would.
 */
async function activateManagedVault(request: APIRequestContext, token: string): Promise<void> {
  let status = await activationCall(request, token, 'post');
  if (status.state === 'failed') {
    expect(status.recovery_available).toBe(true);
    status = await activationCall(request, token, 'post', '/recover');
  }
  for (let read = 0; status.state !== 'ready' && read < ACTIVATION_READS; read += 1) {
    status = await activationCall(request, token, 'get');
  }
  expect(status).toMatchObject({ state: 'ready', credential_received: true });
}

interface ApprovedAgent {
  clientId: string;
  refreshToken: string;
}

/** The agent's own half of signing in, over the wire, as an agent speaks it. */
async function approveAgent(request: APIRequestContext, token: string): Promise<ApprovedAgent> {
  const registered = await request.post(`${backendUrl()}/oauth/register`, {
    data: {
      client_name: AGENT_NAME,
      redirect_uris: [REGISTERED_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
  });
  expect(registered.status()).toBe(HTTP_CREATED);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;

  const verifier = randomBytes(VERIFIER_BYTES).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: PRESENTED_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: randomUUID(),
    scope: AGENT_SCOPE,
    resource: SHARED_EDGE_RESOURCE,
  });
  const consent = await request.get(`${backendUrl()}/oauth/authorize?${query.toString()}`, {
    headers: bearer(token),
  });
  expect(consent.status(), 'the authorization server accepts this account resource').toBe(HTTP_OK);
  const ticket = TICKET.exec(await consent.text())?.[1];
  expect(ticket).toBeDefined();

  const form: Record<string, string> = { ticket: String(ticket), decision: 'approve' };
  for (const scope of AGENT_SCOPE.split(' ')) form[`grant.${scope}`] = 'on';
  const decided = await request.post(`${backendUrl()}/oauth/authorize/decision`, {
    form,
    maxRedirects: 0,
  });
  expect(decided.status()).toBe(HTTP_SEE_OTHER);
  const code = new URL(String(decided.headers()['location'])).searchParams.get('code');

  const exchanged = await request.post(`${backendUrl()}/oauth/token`, {
    form: {
      grant_type: 'authorization_code',
      code: String(code),
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: PRESENTED_REDIRECT,
      resource: SHARED_EDGE_RESOURCE,
    },
  });
  expect(exchanged.status()).toBe(HTTP_OK);
  const tokens = (await exchanged.json()) as { refresh_token: string };
  return { clientId, refreshToken: tokens.refresh_token };
}

async function refresh(request: APIRequestContext, agent: ApprovedAgent): Promise<number> {
  const response = await request.post(`${backendUrl()}/oauth/token`, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: agent.refreshToken,
      client_id: agent.clientId,
    },
  });
  return response.status();
}

/** Open Where your writing lives, returning the connection read the screen rendered. */
async function openVaultSettings(page: Page): Promise<Record<string, unknown>> {
  await page.goto(`${frontendUrl()}/settings`);
  const connectionRead = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/vault/connection',
  );
  await page.getByTestId('settings-row-vault').click();
  const response = await connectionRead;
  expect(response.status()).toBe(HTTP_OK);
  return (await response.json()) as Record<string, unknown>;
}

for (const width of WIDTHS) {
  test(`a ready managed vault with no confirmed agent address says so, and keeps Stop, at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const account = await pilotAccount(page.request);
    await activateManagedVault(page.request, account.token);
    const agent = await approveAgent(page.request, account.token);
    expect(await refresh(page.request, agent)).toBe(HTTP_OK);

    await logIn(page, account.email);
    const connection = await openVaultSettings(page);
    // The private binding never leaves the server, and with discovery
    // unconfirmed there is no public address to name either.
    expect(connection).toMatchObject({ connected: true, vault_url: null, mcp_address: null });

    const section = page.getByTestId('vault-agents-section');
    await expect(section.getByText(AGENTS_MANAGED_ADDRESS_UNAVAILABLE)).toBeVisible();
    await expect(section.getByTestId('vault-agents-address')).toHaveCount(0);
    await expect(section.getByTestId('vault-agents-copy')).toHaveCount(0);
    await expect(section.getByText(SHARED_EDGE_RESOURCE)).toHaveCount(0);

    const listed = await page.request.get(`${backendUrl()}/vault/agents`, {
      headers: bearer(account.token),
    });
    expect(listed.status()).toBe(HTTP_OK);
    const [row] = (await listed.json()) as { id: number; name: string }[];
    expect(row?.name).toBe(AGENT_NAME);
    const agentRow = section.getByTestId(`vault-agent-row-${String(row?.id)}`);
    await expect(agentRow).toContainText(AGENT_NAME);
    const stop = agentRow.getByTestId(`vault-agent-stop-${String(row?.id)}`);
    await expect(stop).toHaveText(AGENTS_STOP);
    await stop.scrollIntoViewIfNeeded();
    const box = await stop.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);

    const revoked = page.waitForResponse(
      (r) =>
        r.request().method() === 'DELETE' &&
        new URL(r.url()).pathname === `/vault/agents/${String(row?.id)}`,
    );
    await stop.click();
    await agentRow.getByTestId(`vault-agent-stop-confirm-${String(row?.id)}`).click();
    expect((await revoked).status()).toBe(HTTP_NO_CONTENT);
    await expect(section.getByText(AGENTS_STOPPED)).toBeVisible();
    await expect(agentRow).toHaveCount(0);
    expect(await refresh(page.request, agent)).toBe(HTTP_BAD_REQUEST);

    // With nothing left listed, the unconfirmed address still offers no
    // invitation to approve an agent it could not be pointed at.
    await expect(section.getByTestId('vault-agents-empty')).toHaveCount(0);
    await expect(section.getByText(AGENTS_EMPTY)).toHaveCount(0);
    await expect(section.getByText(AGENTS_MANAGED_ADDRESS_UNAVAILABLE)).toBeVisible();
  });
}
