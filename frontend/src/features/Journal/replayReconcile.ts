/**
 * What a resent create may write back over the row a replay answered with (#2936).
 *
 * A create re-sent under its idempotency key can be answered with the row its
 * FIRST attempt wrote. By then that row may also hold what the writer did on
 * another device: a stricter tier, a new title, a new chord. So the answer is
 * not "write the page as it stands here" — that would clobber those edits, and
 * could move the entry to a LOOSER tier and hand its words back out to the
 * vault and corpus. It is "write only what changed HERE since the first
 * attempt", and for the privacy tier, only ever towards stricter: the same rule
 * a reconnect retry follows (``isTierLooser``, #2930).
 */
import type { AspectChordValue } from './AspectChordControl';
import { isTierLooser } from './journalSaveRetry';

import type { JournalClassification, JournalEntryUpdate, JournalMessage } from '@/api';

/** What one create attempt of a page carried. */
export interface SentPage {
  message: string;
  title: string | null;
  classification: JournalClassification;
  chord: AspectChordValue;
}

function sameChord(left: AspectChordValue, right: AspectChordValue): boolean {
  return left.primary === right.primary && left.secondary === right.secondary;
}

/**
 * The tier to re-assert, if any: only one chosen here since the first attempt,
 * and only when it is strictly stricter than the tier the replayed row holds. A
 * row whose tier is not reported is never re-tiered — without it there is no
 * way to know the write would not loosen it.
 */
function tierToAssert(
  first: SentPage,
  now: SentPage,
  stored: JournalClassification | undefined,
): JournalClassification | null {
  if (now.classification === first.classification || stored == null) return null;
  return isTierLooser(stored, now.classification) ? now.classification : null;
}

/**
 * The PATCH that brings a replayed row up to date with this page, or ``null``
 * when nothing changed here since the first attempt. Each field is sent only if
 * this page changed it after that attempt; the tier additionally only escalates.
 */
export function replayReconcilePatch(
  first: SentPage,
  now: SentPage,
  stored: JournalMessage,
): JournalEntryUpdate | null {
  const tier = tierToAssert(first, now, stored.classification);
  const patch: JournalEntryUpdate = {
    ...(now.message !== first.message && { message: now.message }),
    ...(now.title !== first.title && { title: now.title }),
    ...(tier != null && { classification: tier }),
    ...(!sameChord(now.chord, first.chord) && {
      primary_aspect: now.chord.primary,
      secondary_aspect: now.chord.secondary,
    }),
  };
  return Object.keys(patch).length > 0 ? patch : null;
}

/*
 * The invisible codepoints the server's sanitizer strips
 * (``backend/src/security/text_sanitize.py``: C0 controls but tab, newline and
 * carriage return; DEL; and its ``_ZERO_WIDTH`` ranges). Built from codepoint
 * numbers, as the server builds its own, so this file carries no invisible
 * characters. Used only to COMPARE a sent answer with a stored one: if the two
 * lists ever drift, the cost is a hint that says "already answered" when it
 * need not, never a lost or altered word.
 */
const STRIPPED_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const hex = (codepoint: number): string => `\\u{${codepoint.toString(16)}}`;

const STRIPPED_BY_SERVER = new RegExp(
  `[${STRIPPED_RANGES.map(([lo, hi]) => `${hex(lo)}-${hex(hi)}`).join('')}]`,
  'gu',
);

/** ``text`` as the server would store it, for comparison only. */
function asStored(text: string): string {
  return text.normalize('NFC').replace(STRIPPED_BY_SERVER, '').trim().normalize('NFC');
}

/** True when a stored answer is ``sent``, allowing for what the sanitizer changes. */
export function isStoredAs(stored: string | null, sent: string): boolean {
  return stored != null && asStored(stored) === asStored(sent);
}
