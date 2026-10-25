import { describe, afterAll, beforeAll, expect, it } from '@jest/globals';

import { readLaneState } from './laneState';

import { auth, setTokenGetter, vault } from '@/api';

/**
 * Recent agent activity, read across the wire (#3535).
 *
 * The production client asks `GET /vault/agents/activity`; the server resolves
 * the lane's bound owner to the lane's Creek vault (`fakeCreekVault.mjs`), reads
 * its 0.22 `GET /v1/agent-activity` through the real adapter and its strict
 * parse, and answers four fields per call in its own words.
 *
 * What this lane cannot do is make the calls: they would arrive at the vault's
 * `/mcp` endpoint, and the lane's vault is a contract fake of `/v1` with no MCP
 * surface. So the spec stands in for the vault's audit chain itself
 * (`POST /__lane/record-agent-call`), writing exactly what Creek's adapter would
 * have audited -- a stamp, a tool and an outcome -- and everything from there to
 * the screen's client is the production path.
 *
 * Attribution is pinned for the two stamps this account can be told apart
 * by today: `adepthood` is Adepthood, and a stamp the account owns no grant for
 * is never echoed -- it is "something else with access to your vault". A real
 * agent's stamp is its person's `sub` until Creek-Vault#1976 stamps its
 * `client_id`; that mapping is pinned in-process by
 * `backend/tests/routers/test_vault_agent_activity.py`.
 */

const HTTP_OK = 200;
const ACTIVITY_LIMIT = 20;
/** A stamp this account holds no grant for, as an operator's static consumer would be. */
const UNPLACED_STAMP = 'openclaw-static-consumer';
/** What `fakeCreekVault.mjs` smuggles into an armed off-schema answer. */
const LEAKED_PROSE = 'The lane vault leaked this sentence.';
const ROW_KEYS = ['agent', 'at', 'outcome', 'tool_label'];

const lane = readLaneState();

/** POST one lane-only control call to the vault, failing loudly if it is refused. */
async function laneVault(path: string, body?: Record<string, string>): Promise<void> {
  if (lane === null) throw new Error('globalSetup recorded no lane state');
  const response = await fetch(`${lane.vaultUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${lane.vaultApiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status !== HTTP_OK) {
    throw new Error(`the lane's vault answered ${path} with ${response.status}`);
  }
}

describe('vault.agent-activity-recent against a live server', () => {
  let sessionToken: string | null = null;

  beforeAll(async () => {
    if (lane === null) throw new Error('globalSetup recorded no lane state');
    const session = await auth.login({
      email: lane.vaultOwnerEmail,
      password: lane.vaultOwnerPassword,
    });
    sessionToken = session.token;
    setTokenGetter(() => sessionToken);
  });

  afterAll(() => {
    setTokenGetter(null);
  });

  it('answers an empty log as nothing yet, not as an unavailable vault', async () => {
    expect(await vault.agentActivity(ACTIVITY_LIMIT)).toEqual({ status: 'ok', rows: [] });
  });

  it('shows the draft call, the refused re-sort and the app’s own save, newest first', async () => {
    await laneVault('/__lane/record-agent-call', {
      consumer: 'adepthood',
      tool: 'creek.journal',
      outcome: 'admitted',
    });
    await laneVault('/__lane/record-agent-call', {
      consumer: UNPLACED_STAMP,
      tool: 'creek.link',
      outcome: 'refused',
    });
    await laneVault('/__lane/record-agent-call', {
      consumer: UNPLACED_STAMP,
      tool: 'creek.draft',
      outcome: 'admitted',
    });

    const activity = await vault.agentActivity(ACTIVITY_LIMIT);

    expect(activity.status).toBe('ok');
    expect(activity.rows.map((row) => Object.keys(row).sort())).toEqual([
      ROW_KEYS,
      ROW_KEYS,
      ROW_KEYS,
    ]);
    expect(
      activity.rows.map(({ agent, tool_label, outcome }) => [agent, tool_label, outcome]),
    ).toEqual([
      ['Something else with access to your vault', 'Drafted an essay', 'admitted'],
      ['Something else with access to your vault', 'Tried to re-sort the vault', 'refused'],
      ['Adepthood', 'Saved a journal entry', 'admitted'],
    ]);
    expect(JSON.stringify(activity)).not.toContain(UNPLACED_STAMP);
    expect(JSON.stringify(activity)).not.toContain('creek.');
  });

  it('asks the vault for no more than the screen shows', async () => {
    expect((await vault.agentActivity(1)).rows).toHaveLength(1);
  });

  it('refuses a vault answer carrying more than four fields, and shows none of it', async () => {
    await laneVault('/__lane/leak-next-activity');

    const activity = await vault.agentActivity(ACTIVITY_LIMIT);

    expect(activity).toEqual({ status: 'unavailable', rows: [] });
    expect(JSON.stringify(activity)).not.toContain(LEAKED_PROSE);
    expect((await vault.agentActivity(ACTIVITY_LIMIT)).rows).toHaveLength(3);
  });
});
