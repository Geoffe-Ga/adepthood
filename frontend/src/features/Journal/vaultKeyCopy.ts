/**
 * The words for a reading or letter a managed vault writes with the writer's own key (#3437).
 *
 * ADR 0009's 2026-10-16 amendment: with a managed vault and a key of their own,
 * a writer's vault writes their readings and letters with that key, and the key
 * pays instead of BotMason credits. Each such use is labelled, before it runs
 * (the price line) and after (the pass receipt), with the vendor the key
 * belongs to. The label names the vendor, never the key.
 */
import type { z } from 'zod';

import type { vaultKeyVendorSchema } from '@/api/schemas';
import { providerForKey } from '@/features/Settings/byokProviders';

export type VaultKeyVendor = z.infer<typeof vaultKeyVendorSchema>;

const VENDOR_NAMES: Record<VaultKeyVendor, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/** The per-use label on a pass the vault wrote with the writer's key. */
export function vaultKeyReceiptLabel(vendor: VaultKeyVendor): string {
  return `Written by your own ${VENDOR_NAMES[vendor]} key, through your vault`;
}

/** The price line before a reading or letter the vault will write with the writer's key. */
export function vaultKeyCost(vendor: VaultKeyVendor, noun: string): string {
  return `${vaultKeyReceiptLabel(vendor)}. Your key pays for this ${noun}; nothing is drawn from your BotMason messages.`;
}

/** The vendor a stored key belongs to, read from its prefix; ``null`` without a usable key. */
export function vaultKeyVendorFor(key: string | null): VaultKeyVendor | null {
  if (key === null) return null;
  return providerForKey(key.trim())?.id ?? null;
}
