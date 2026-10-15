/** Payment copy follows the server's reading route, never key presence alone. */
import { resonanceExplainerCanContinue, resonanceExplainerCost } from './resonanceExplainerCopy';

import { botmasonUsage } from '@/api';

const READING = 'reading';

export interface ResonanceCostState {
  copy: string;
  keyNeeded: boolean;
  canContinue: boolean;
  fundingRequired: 'key_required' | 'wallet_exhausted' | null;
  loading: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
}

/** An absent/failed route read records no payer and authorizes no charge. */
export function unknownCostState(noun: string = READING): ResonanceCostState {
  return {
    keyNeeded: false,
    copy: `We couldn't check how this ${noun} would be paid for. Close this note and try again.`,
    canContinue: false,
    fundingRequired: null,
    loading: false,
    monthlyResetDate: null,
    monthlyCap: null,
  };
}

export const UNKNOWN_COST_STATE: ResonanceCostState = unknownCostState();

type Usage = Awaited<ReturnType<typeof botmasonUsage.get>>;

function ownKeyCost(hasKey: boolean, noun: string): ResonanceCostState {
  return {
    keyNeeded: !hasKey,
    copy: resonanceExplainerCost(hasKey, null, null, null, noun),
    canContinue: hasKey,
    fundingRequired: hasKey ? null : 'key_required',
    loading: false,
    monthlyResetDate: null,
    monthlyCap: null,
  };
}

function costStateFromUsage(usage: Usage, hasKey: boolean, noun: string): ResonanceCostState {
  if (usage.resonance_route === 'app_provider') return ownKeyCost(hasKey, noun);
  if (usage.resonance_route !== 'vault_bound') return unknownCostState(noun);
  // Vault readings and first letters spend credits even with an own key (#3281/#3346).
  const canContinue = resonanceExplainerCanContinue(
    false,
    usage.monthly_messages_remaining,
    usage.offering_balance,
  );
  return {
    keyNeeded: false,
    copy: resonanceExplainerCost(
      hasKey,
      usage.monthly_cap,
      usage.monthly_messages_remaining,
      usage.offering_balance,
      noun,
      true,
    ),
    canContinue,
    fundingRequired: canContinue ? null : 'wallet_exhausted',
    loading: false,
    monthlyResetDate: usage.monthly_reset_date,
    monthlyCap: usage.monthly_cap,
  };
}

/** A binding identifies a route, not a guarantee that the vault can answer. */
export async function loadCostState(
  hasKey: boolean,
  noun: string = READING,
  token?: string,
): Promise<ResonanceCostState> {
  try {
    return costStateFromUsage(await botmasonUsage.get(token), hasKey, noun);
  } catch {
    return unknownCostState(noun);
  }
}
