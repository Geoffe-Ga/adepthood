/**
 * Persist a transcribed journal page as a finished entry.
 *
 * The write is two steps — create the entry from the body, then flip it to
 * `finished` — so a failure between them can strand a freshly-created draft. To
 * keep a retry from creating a duplicate, callers pass the id returned by the
 * first successful create back in as `existingId`: with an id in hand this
 * PATCHes the existing entry instead of creating again. Because a
 * PATCH failure rejects before the id can be returned, `onCreated` lets a caller
 * latch the fresh id the instant the create succeeds, so a subsequent retry can
 * supply it. On create, the message body is sent along with an optional
 * `entry_date` (a backdate); when it is omitted the backend stamps today. The
 * finishing PATCH and any retry send only the body and status, never a date.
 *
 * `existingId` cannot help when the create's own answer is lost: `onCreated`
 * never fires, and a retry would create the page a second time. A caller-held
 * `createKey` closes that (#2936): every create attempt of one capture is sent
 * under one idempotency key, so the server answers a repeat with the entry it
 * already wrote. That answer is the row as first written, or as since edited
 * elsewhere, so a resent create's finishing PATCH carries only what changed
 * here since the first attempt — and a tier only when it is stricter than the
 * row's (``replayReconcilePatch``). A backdate is not reconciled: the capture
 * screen fixes it before the first attempt.
 */
import { EMPTY_CHORD } from './AspectChordControl';
import { claimCreateAttempt, type CreateKeyRef } from './createKey';
import { DEFAULT_TIER } from './PrivacyTierControl';
import { replayReconcilePatch, type SentPage } from './replayReconcile';

import { journal } from '@/api';
import type { JournalClassification, JournalEntryUpdate, JournalMessageCreate } from '@/api';

/** The status a fully-captured page is flipped to once its body is saved. */
const FINISHED_STATUS = 'finished' as const;

/**
 * Save `body` as a finished journal entry and resolve its id.
 *
 * With no `existingId` (or `null`), create the entry then PATCH it to finished.
 * With an `existingId` — a create that already succeeded on a prior attempt —
 * skip the create and re-run the finishing PATCH with the current `body`, so a
 * retry after a failed PATCH never re-creates the page yet still persists any
 * edits made after the failure. `onCreated`, when given, fires with the new id
 * the moment the create resolves (before the PATCH), so a caller can hold it for
 * a retry even if the PATCH then rejects. `entryDate`, when given, backdates the
 * created entry; it is sent only on create, never on a retry PATCH. `classification`
 * is the privacy tier chosen during capture; like `entryDate` it rides only the
 * create (the tier is set at birth), never the finishing or retry PATCH — except
 * after a resent create, whose replayed row may predate them. `createKey`, when
 * given, holds this capture's idempotency key across attempts. Rejections
 * propagate to the caller.
 */
export async function saveFinishedEntry(
  body: string,
  existingId?: number | null,
  onCreated?: (_id: number) => void,
  entryDate?: string,
  classification?: JournalClassification,
  createKey?: CreateKeyRef<SentPage>,
): Promise<number> {
  if (existingId == null) {
    const payload: JournalMessageCreate = {
      message: body,
      ...(classification != null && { classification }),
      ...(entryDate != null && { entry_date: entryDate }),
    };
    // A capture has no title or chord, so only the body and tier can differ.
    const now: SentPage = {
      message: body,
      title: null,
      classification: classification ?? DEFAULT_TIER,
      chord: EMPTY_CHORD,
    };
    const attempt = createKey ? claimCreateAttempt(createKey, now) : null;
    const created = await journal.create(payload, attempt ? { idempotencyKey: attempt.key } : {});
    onCreated?.(created.id);
    const reconcile = attempt?.resent ? replayReconcilePatch(attempt.first, now, created) : null;
    const finishing: JournalEntryUpdate = { ...reconcile, status: FINISHED_STATUS };
    await journal.update(created.id, finishing);
    return created.id;
  }
  await journal.update(existingId, { message: body, status: FINISHED_STATUS });
  return existingId;
}
