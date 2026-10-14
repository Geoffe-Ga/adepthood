/**
 * The payer snapshot behind a charged journal depth's price line.
 *
 * A resonance pass and a note's first letter are both priced here, from the
 * same read of ``/user/usage``, and differ only in what they call the charged
 * thing. The read is defensive on purpose: a failed usage request (or a
 * component test that supplies a partial API seam) falls back to a generic "one
 * BotMason message" statement rather than a guessed allowance, so the
 * disclosure stays truthful.
 *
 * Since ADR 0009 phase (a) (#3067) BotMason credits pay only for a reading the
 * writer's own vault answers. So with no key of the writer's own (#3262):
 *
 * - a letter never has a price: it always goes to the app's provider, which
 *   only the writer's key can pay for, so its line says the key is needed;
 * - a reading has a price only when a vault might answer it. When the server
 *   has said nothing is attached, the line says the key is needed instead. A
 *   managed binding, a connected vault, or an unread connection keeps the
 *   price: a vault may answer, and if it cannot the server refuses before
 *   anything is spent. (The deployment-wide vault's single owner reads as
 *   unconnected here -- the gap ``vaultComesFirst`` documents -- and is told to
 *   add a key although their vault answers.)
 *
 * A development build is the exception, for the reason
 * ``KEYLESS_PAGE_READ_REACHES_SERVER`` gives: its local server's stub seam can
 * answer a keyless request, so the shipped price lines stay.
 */
import {
  keyNeededCost,
  resonanceExplainerCanContinue,
  resonanceExplainerCost,
} from './resonanceExplainerCopy';

import { botmasonUsage } from '@/api';
import { KEYLESS_GENERATION_REACHES_SERVER } from '@/config';
import { fetchVaultConnectionState } from '@/features/Settings/useVaultConnectionState';

/** What the reading's price line calls the thing it charges for. */
const READING = 'reading';

export interface ResonanceCostState {
  copy: string;
  canContinue: boolean;
  loading: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
  /** Nothing but the writer's own key can pay: the line sends them to Settings. */
  keyNeeded: boolean;
}

/** The price line before (or without) a usage read: no allowance is guessed. */
export function unknownCostState(noun: string = READING): ResonanceCostState {
  return {
    copy: resonanceExplainerCost(false, null, null, null, noun),
    canContinue: true,
    loading: false,
    monthlyResetDate: null,
    monthlyCap: null,
    keyNeeded: false,
  };
}

export const UNKNOWN_COST_STATE: ResonanceCostState = unknownCostState();

/** The writer's own key pays: no wallet is read or drawn on. */
function ownKeyCostState(noun: string): ResonanceCostState {
  return { ...unknownCostState(noun), copy: resonanceExplainerCost(true, null, null, null, noun) };
}

/** Only the writer's own key could pay, and there is none: no price, only Settings. */
export function keyNeededCostState(noun: string = READING): ResonanceCostState {
  return {
    ...unknownCostState(noun),
    copy: keyNeededCost(noun),
    canContinue: false,
    keyNeeded: true,
  };
}

/**
 * The price line that needs no read at all, or ``null`` when it does.
 *
 * Synchronous so a surface can open on the true line instead of flashing a
 * generic price first: a key pays, or the thing is a letter nothing else can
 * pay for.
 */
export function knownCostState(hasKey: boolean, noun: string = READING): ResonanceCostState | null {
  if (hasKey) return ownKeyCostState(noun);
  if (!KEYLESS_GENERATION_REACHES_SERVER && noun !== READING) return keyNeededCostState(noun);
  return null;
}

type Usage = Awaited<ReturnType<typeof botmasonUsage.get>>;

function costStateFromUsage(usage: Usage, noun: string): ResonanceCostState {
  return {
    copy: resonanceExplainerCost(
      false,
      usage.monthly_cap,
      usage.monthly_messages_remaining,
      usage.offering_balance,
      noun,
    ),
    canContinue: resonanceExplainerCanContinue(
      false,
      usage.monthly_messages_remaining,
      usage.offering_balance,
    ),
    loading: false,
    monthlyResetDate: usage.monthly_reset_date,
    monthlyCap: usage.monthly_cap,
    keyNeeded: false,
  };
}

/** Whether a keyless reading may be answered by a vault, so credits may pay for it. */
async function aVaultMayAnswer(): Promise<boolean> {
  if (KEYLESS_GENERATION_REACHES_SERVER) return true;
  return (await fetchVaultConnectionState()).kind !== 'none';
}

/** Read the payer's price line: the caller's own key, else what credits can pay. */
export async function loadCostState(
  hasKey: boolean,
  noun: string = READING,
): Promise<ResonanceCostState> {
  const known = knownCostState(hasKey, noun);
  if (known !== null) return known;
  if (!(await aVaultMayAnswer())) return keyNeededCostState(noun);
  try {
    return costStateFromUsage(await botmasonUsage.get(), noun);
  } catch {
    return unknownCostState(noun);
  }
}
