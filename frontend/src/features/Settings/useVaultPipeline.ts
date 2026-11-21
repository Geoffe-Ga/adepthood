import { create } from 'zustand';

import { vault, type VaultPipeline } from '@/api';
import { captureAuthScope, isAuthScopeCurrent } from '@/api/sessionToken';
import { registerStoreReset } from '@/store/registry';

/**
 * The "Your vault" dashboard read (``GET /vault/pipeline``, #3776), shared by
 * the dashboard screen and the Seed run's rows.
 *
 * One store rather than two reads so a Seed run that has just finished, and the
 * dashboard opened from it, show the same receipts: the row says where a file
 * landed, and the dashboard it links to says the same thing.
 *
 * ``failed`` is the latest read's outcome. A failed read keeps the answer
 * before it standing -- it is still the truest thing known -- and says so, so
 * the screen can offer to read again. Every answer is bound to the account and
 * session it was asked under, and the store is cleared on every account
 * boundary, so one account's receipts never render on another's screen.
 */

interface PipelineState {
  answer: VaultPipeline | null;
  failed: boolean;
}

const INITIAL: PipelineState = { answer: null, failed: false };

const usePipelineState = create<PipelineState>(() => INITIAL);
let generation = 0;

registerStoreReset(() => {
  generation += 1;
  usePipelineState.setState(INITIAL);
});

/**
 * Read the dashboard once. Resolves ``true`` when an answer landed, ``false``
 * when the read failed or its answer arrived for an account no longer here.
 */
export async function refreshVaultPipeline(): Promise<boolean> {
  const epoch = generation;
  const scope = captureAuthScope();
  const current = (): boolean => generation === epoch && isAuthScopeCurrent(scope);
  try {
    const answer = await vault.pipeline();
    if (!current()) return false;
    usePipelineState.setState({ answer, failed: false });
    return true;
  } catch {
    if (current()) usePipelineState.setState({ failed: true });
    return false;
  }
}

/** The dashboard read as last known, and whether the latest read failed. */
export function useVaultPipeline(): PipelineState {
  return usePipelineState((state) => state);
}
