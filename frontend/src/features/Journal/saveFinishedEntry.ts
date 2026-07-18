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
 * supply it. Nothing beyond the message body is sent; the backend defaults
 * classification and entry date, so we never override them here.
 */
import { journal } from '@/api';

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
 * a retry even if the PATCH then rejects. Rejections propagate to the caller.
 */
export async function saveFinishedEntry(
  body: string,
  existingId?: number | null,
  onCreated?: (_id: number) => void,
): Promise<number> {
  if (existingId == null) {
    const created = await journal.create({ message: body });
    onCreated?.(created.id);
    await journal.update(created.id, { status: FINISHED_STATUS });
    return created.id;
  }
  await journal.update(existingId, { message: body, status: FINISHED_STATUS });
  return existingId;
}
