import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { freshLicenseKey } from './licenseKey';

import { ApiError, auth, botmasonUsage, journal, resonance, setTokenGetter } from '@/api';

/**
 * A note's first letter, priced, across the wire (#623).
 *
 * The owner's ratified launch economy charges one wallet unit for a note's
 * first essay and nothing to reopen it. The in-repo rule that a charged depth is
 * offered with its price on it is enforced at the server too: a server-paid
 * first letter without ``price_acknowledged`` is refused with 409 before anything
 * is charged. The facts a live server can confirm and neither half can on its
 * own:
 *
 * - the refusal really charges nothing, in the wallet *and* its audit trail;
 * - the acknowledged ask really takes its unit, and -- because this lane serves
 *   the stub provider, whose letter is a labelled demo (#3062) -- hands it back
 *   in the same commit, so the audit trail reads spend then ``refund_demo``
 *   and the balances the essay answer carries agree with ``GET /user/usage``;
 * - reopening the cached letter really is free: no balance change and no new
 *   audit row.
 *
 * The audit trail is read out of band through ``tests.e2e.wallet_audit``,
 * because ``walletaudit`` deliberately has no API. Without it a spec could see an
 * unchanged balance but could not tell "never charged" apart from "charged and
 * refunded".
 *
 * Not covered here: a real provider's letter whose charge is kept. Every lane
 * serves the stub, so that half is pinned by the backend suite
 * (``test_inference_provenance.py``) and declared uncovered in
 * ``journeys.json`` (#3062).
 *
 * Not covered here either: the exhausted-wallet 402. Arranging an empty wallet needs a
 * write the wire deliberately does not offer, and spending it down through the
 * routes runs into their per-minute limit. The backend suite pins it
 * (``test_empty_wallet_essay_is_402_before_provider``), and so does the
 * screen's Jest suite (an essay 402 opens the refill dialog).
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = freshLicenseKey();
const CONFLICT = 409;
const WALLET_MODULE = 'tests.e2e.wallet_audit';
/** How the wallet service names a spend from the free monthly allowance. */
const SPEND_MONTHLY = 'spend_monthly';
/** How the wallet service names the hand-back of a demo generation's unit (#3062). */
const REFUND_DEMO = 'refund_demo';

const PAGE =
  'The heron stood in the shallows until the light changed. I stood with it longer than I meant to.';

const email = `e2e-essay-economy-${randomUUID()}${EMAIL_DOMAIN}`;

/** One row of `walletaudit`, as `tests.e2e.wallet_audit` reports it. */
interface WalletRow {
  reason: string;
}

/** An account's wallet and its whole audit trail, read out of band. */
interface Wallet {
  monthly_messages_used: number;
  offering_balance: number;
  rows: WalletRow[];
}

function readWallet(): Wallet {
  return JSON.parse(runBackendModule(WALLET_MODULE, ['show', '--email', email])) as Wallet;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`the live journey returned no ${name}`);
  return value;
}

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('a first letter is priced, acknowledged, charged once, and reopened free', () => {
  let sessionToken: string | null = null;
  let marginaliaId = 0;
  let letter = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can move its wallet', async () => {
    const session = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });
    sessionToken = session.token;
    setTokenGetter(() => sessionToken);
    expect(session.user_id).toBeGreaterThan(0);
  });

  it('writes a page and has a resonance pass leave a margin note on it', async () => {
    const entry = await journal.create({ message: PAGE, classification: 'personal' });
    await journal.update(entry.id, { status: 'finished' });
    const pass = await resonance.generate(entry.id);
    marginaliaId = required(pass.marginalia[0], 'margin note').id;
    expect(marginaliaId).toBeGreaterThan(0);
  });

  it('refuses a server-paid letter whose price was not acknowledged, and charges nothing', async () => {
    const usageBefore = await botmasonUsage.get();
    const walletBefore = readWallet();

    const error = await rejection(resonance.essay(marginaliaId));

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(CONFLICT);
    expect((error as ApiError).detail).toBe('essay_price_unacknowledged');
    expect(await botmasonUsage.get()).toEqual(usageBefore);
    expect(readWallet()).toEqual(walletBefore);
  });

  it('takes the unit for the acknowledged ask and hands a demo letter its unit back', async () => {
    const usageBefore = await botmasonUsage.get();
    const walletBefore = readWallet();

    const answered = await resonance.essay(marginaliaId, { priceAcknowledged: true });
    letter = (answered.essay ?? '').trim();
    const usageAfter = await botmasonUsage.get();
    const walletAfter = readWallet();

    expect(letter).not.toBe('');
    expect(answered.essay_source).toBe('demo');
    expect(usageAfter.monthly_messages_used).toBe(usageBefore.monthly_messages_used);
    expect(usageAfter.monthly_messages_remaining).toBe(usageBefore.monthly_messages_remaining);
    expect(usageAfter.offering_balance).toBe(usageBefore.offering_balance);
    // The essay's own balances are the same numbers the usage read reports.
    expect(answered.remaining_messages).toBe(usageAfter.monthly_messages_remaining);
    expect(answered.remaining_balance).toBe(usageAfter.offering_balance);
    expect(answered.monthly_reset_date).toBe(usageAfter.monthly_reset_date);
    // The unit really was taken before the dial and really handed back after
    // it: a spend and its demo refund, never silence and never a kept charge.
    expect(walletAfter.rows.slice(walletBefore.rows.length).map((row) => row.reason)).toEqual([
      SPEND_MONTHLY,
      REFUND_DEMO,
    ]);
  });

  it('reopens the cached letter for free, acknowledged or not', async () => {
    const usageBefore = await botmasonUsage.get();
    const walletBefore = readWallet();

    const reopened = await resonance.essay(marginaliaId);
    const reaskedOnPurpose = await resonance.essay(marginaliaId, { priceAcknowledged: true });

    expect((reopened.essay ?? '').trim()).toBe(letter);
    expect((reaskedOnPurpose.essay ?? '').trim()).toBe(letter);
    expect(reopened.remaining_messages).toBe(usageBefore.monthly_messages_remaining);
    expect(await botmasonUsage.get()).toEqual(usageBefore);
    expect(readWallet()).toEqual(walletBefore);
  });
});
