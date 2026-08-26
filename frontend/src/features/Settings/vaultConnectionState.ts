/**
 * What the private-vault screen knows about the account's vault.
 *
 * Three answers, not two. ``GET /vault/connection`` serves every account rather
 * than 404ing one that has attached nothing, so a failed read is a failure to
 * reach the server and says nothing at all about whether a vault is there —
 * which makes "nobody could check" a third state, distinct from "checked, and
 * there is none". Folding the two together renders the empty state over a vault
 * that exists and lets a single press overwrite it without asking.
 *
 * Kept beside the screen rather than inside ``useVaultConnection``: the hook is
 * already at its line budget, and this is the part worth reading on its own.
 */
import type { VaultConnection } from '@/api';

/**
 * The account's vault, as far as this device can tell.
 *
 * A discriminated union rather than a nullable address, so the third answer has
 * somewhere to live and every render has to say what it does with it.
 */
export type VaultConnectionState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }
  | { readonly kind: 'connected'; readonly address: string };

/** Nobody has established what is attached — before the read, or after it failed. */
export const CONNECTION_UNKNOWN: VaultConnectionState = { kind: 'unknown' };

/** The server answered, and there is nothing attached. */
export const NOTHING_CONNECTED: VaultConnectionState = { kind: 'none' };

/**
 * A vault is attached at ``address``.
 *
 * Not exported: the two certain-nothing states are values anyone can hold, but
 * a connected state is only ever learned from a server answer, so it is built
 * here and nowhere else.
 */
function connectedTo(address: string): VaultConnectionState {
  return { kind: 'connected', address };
}

/**
 * Read a server answer as one of the three states.
 *
 * ``connected`` with a null address maps to *unknown* rather than to *none*.
 * The server cannot produce that pair, but the type can, and reading it as
 * "nothing attached" would answer a question nobody answered: it would render
 * the empty state and let one press replace a binding without asking, which is
 * the exact defect the third state exists to remove. Unknown costs a
 * confirmation; none costs somebody their vault.
 */
export function readConnectionState(connection: VaultConnection): VaultConnectionState {
  if (!connection.connected) return NOTHING_CONNECTED;
  if (connection.vault_url === null) return CONNECTION_UNKNOWN;
  return connectedTo(connection.vault_url);
}
