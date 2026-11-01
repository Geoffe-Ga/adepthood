/**
 * Distinguish a failed connection read from a confirmed absence, a managed
 * binding with a private address, the deployment-wide vault, and a vault whose
 * address can be displayed.
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
  | ({ readonly kind: 'managed'; readonly agentAddress?: string | null } & SortNote)
  /**
   * The deployment-wide vault this account is the bound owner of (#3608). The
   * operator's configuration rather than the account's row, so it carries no
   * address and offers nothing to disconnect.
   */
  | ({ readonly kind: 'deployment' } & SortNote)
  | ({
      readonly kind: 'connected';
      readonly address: string;
      /** What a person gives an agent they run elsewhere (#3534), when the server says. */
      readonly agentAddress: string | null;
    } & SortNote);

/**
 * The server's sentence saying the vault's sort is not finished (#3577).
 *
 * Present only when the server sent one, which it does only for a rules-only
 * or partial sort. It rides the vault it is about, so a disconnect that
 * replaces the state drops it, and a connect reply that carries one brings it.
 */
interface SortNote {
  readonly classificationMessage?: string;
}

/** The sort sentence from a server answer, as a field only when there is one. */
function sortNote(connection: VaultConnection): SortNote {
  const message = connection.classification_message;
  return message ? { classificationMessage: message } : {};
}

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
function connectedTo(
  address: string,
  agentAddress: string | null,
  note: SortNote,
): VaultConnectionState {
  return { kind: 'connected', address, agentAddress, ...note };
}

/**
 * The deployment source is read first and carries nothing but the sort note,
 * so an address that rode along on it by mistake still has nowhere to land.
 * Otherwise a null vault_url identifies the private managed binding -- which is
 * also how a server from before `source` answers -- and its public agent
 * address is independent: retain it when the server can name one.
 */
export function readConnectionState(connection: VaultConnection): VaultConnectionState {
  if (!connection.connected) return NOTHING_CONNECTED;
  if (connection.source === 'deployment') return { kind: 'deployment', ...sortNote(connection) };
  if (connection.vault_url === null) {
    return { kind: 'managed', agentAddress: connection.mcp_address, ...sortNote(connection) };
  }
  return connectedTo(connection.vault_url, connection.mcp_address, sortNote(connection));
}

/**
 * Whether bringing in writing has to wait for a place to keep it (#3017).
 *
 * A corpus lives in a vault (#3015), so a document has nowhere to go until the
 * account has one. True only when the server has said nothing is attached:
 * a managed binding, the deployment-wide vault's bound owner (#3608) or an
 * unknown read is never read as none, and the server's own `vault_required`
 * answer is the backstop for those.
 */
export function vaultComesFirst(vault: VaultConnectionState): boolean {
  return vault.kind === 'none';
}
