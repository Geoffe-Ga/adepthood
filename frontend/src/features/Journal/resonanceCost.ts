/**
 * The payer snapshot behind a charged journal depth's price line.
 *
 * A resonance pass and a note's first letter both spend one unit of the same
 * BotMason wallet, so both price lines are built from the same read of
 * ``/user/usage`` and differ only in what they call the charged thing. The read
 * is defensive on purpose: a failed usage request (or a component test that
 * supplies a partial API seam) falls back to a generic "one BotMason message"
 * statement rather than a guessed allowance, so the disclosure stays truthful.
 */
import { resonanceExplainerCanContinue, resonanceExplainerCost } from './resonanceExplainerCopy';

import { botmasonUsage } from '@/api';

/** What the reading's price line calls the thing it charges for. */
const READING = 'reading';

export interface ResonanceCostState {
  copy: string;
  canContinue: boolean;
  loading: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
}

/** The price line before (or without) a usage read: no allowance is guessed. */
export function unknownCostState(noun: string = READING): ResonanceCostState {
  return {
    copy: resonanceExplainerCost(false, null, null, null, noun),
    canContinue: true,
    loading: false,
    monthlyResetDate: null,
    monthlyCap: null,
  };
}

export const UNKNOWN_COST_STATE: ResonanceCostState = unknownCostState();

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
  };
}

/** Read the payer's price line: the caller's own key, else the wallet's allowance. */
export async function loadCostState(
  hasKey: boolean,
  noun: string = READING,
): Promise<ResonanceCostState> {
  if (hasKey) {
    return {
      copy: resonanceExplainerCost(true, null, null, null, noun),
      canContinue: true,
      loading: false,
      monthlyResetDate: null,
      monthlyCap: null,
    };
  }
  try {
    return costStateFromUsage(await botmasonUsage.get(), noun);
  } catch {
    return unknownCostState(noun);
  }
}
