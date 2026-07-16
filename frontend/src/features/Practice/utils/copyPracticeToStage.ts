import { type PracticeCreatePayload, type PracticeItem, practices, userPractices } from '@/api';

/**
 * Build the ``POST /practices/`` payload for a cross-stage copy.
 *
 * The name is carried over verbatim (no "(copy)" suffix — that decoration
 * belongs to the "Duplicate & edit" flow, not this one). ``mode`` and
 * ``mode_config`` are included only when the source defines them so the
 * payload never carries ``undefined`` values the server would reject.
 */
function buildCopyPayload(practice: PracticeItem, targetStage: number): PracticeCreatePayload {
  const payload: PracticeCreatePayload = {
    stage_number: targetStage,
    name: practice.name,
    description: practice.description,
    instructions: practice.instructions,
    default_duration_minutes: practice.default_duration_minutes,
  };
  if (practice.mode !== undefined) payload.mode = practice.mode;
  if (practice.mode_config !== undefined) payload.mode_config = practice.mode_config;
  return payload;
}

/**
 * Copy a practice into a user-owned draft at ``targetStage`` and assign it.
 *
 * Creates the draft (approved=false, owned by the caller), then assigns it as
 * the active practice for the target stage, and resolves with the created
 * draft so callers can record it (e.g. in recents).
 *
 * Partial-failure semantics: there is no rollback. If the create succeeds but
 * the assign rejects, an orphaned owner draft is left behind in "My drafts"
 * (harmless and user-recoverable). This function re-throws the rejection so the
 * caller can surface the error and decline to navigate.
 */
export async function copyPracticeToStage(
  practice: PracticeItem,
  targetStage: number,
): Promise<PracticeItem> {
  const draft = await practices.create(buildCopyPayload(practice, targetStage));
  await userPractices.create({ practice_id: draft.id, stage_number: targetStage });
  return draft;
}
