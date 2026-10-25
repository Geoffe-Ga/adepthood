/**
 * Distinguish a failed connection read from a confirmed absence, a managed
 * binding with a private address, and a vault whose address can be displayed.
 * A stored binding is not a live health check.
 */
import type { VaultConnection } from '@/api';

/**
 * The account's vault, as far as this device can tell.
 *
 * Each known connection remains distinct from an absent or unread binding.
 */
export type VaultConnectionState =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'none' }
  | { readonly kind: 'managed'; readonly agentAddress?: string | null }
  | {
      readonly kind: 'connected';
      readonly address: string;
      /** What a person gives an agent they run elsewhere (#3534), when the server says. */
      readonly agentAddress: string | null;
    };

/** Nobody has established what is attached — before the read, or after it failed. */
export const CONNECTION_UNKNOWN: VaultConnectionState = { kind: 'unknown' };

/** The server answered, and there is nothing attached. */
export const NOTHING_CONNECTED: VaultConnectionState = { kind: 'none' };

/**
 * A vault is attached at ``address``, and agents are given ``agentAddress``.
 *
 * Not exported: the two certain-nothing states are values anyone can hold, but
 * a connected state is only ever learned from a server answer, so it is built
 * here and nowhere else.
 */
function connectedTo(address: string, agentAddress: string | null): VaultConnectionState {
  return { kind: 'connected', address, agentAddress };
}

/**
 * A null vault_url identifies the private managed binding. Its public agent
 * address is independent: retain it when the server can name one.
 */
export function readConnectionState(connection: VaultConnection): VaultConnectionState {
  if (!connection.connected) return NOTHING_CONNECTED;
  if (connection.vault_url === null) {
    return { kind: 'managed', agentAddress: connection.mcp_address };
  }
  return connectedTo(connection.vault_url, connection.mcp_address);
}

/**
 * Whether bringing in writing has to wait for a place to keep it (#3017).
 *
 * A corpus lives in a vault (#3015), so a document has nowhere to go until the
 * account has one. True only when the server has said nothing is attached:
 * a managed binding or an unknown read is
 * never read as none, and the server's own `vault_required` answer is the
 * backstop for those.
 *
 * One known gap, accepted: the deployment-wide vault's single owner
 * (`CREEK_VAULT_OWNER_USER_ID`) has no connection row, so the server answers
 * them `connected: false` and this holds for them although their imports land.
 * The fix is a server-side has-a-vault signal, not a guess made here.
 */
export function vaultComesFirst(vault: VaultConnectionState): boolean {
  return vault.kind === 'none';
}
