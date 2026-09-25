/**
 * The beta-feedback reporter's draft, kept on the device between visits (#2898).
 *
 * One row per account, under `scopedKey`, holding what the tester has written,
 * the ONE idempotency key minted for this draft, and -- after a send whose
 * outcome is unknown -- the frozen attempt that "Send again" must resend byte
 * for byte. `wipeUserState` clears it on logout and on a change of device owner.
 *
 * Nothing here ever logs the row. Every warning is a fixed string with no error
 * object attached: on the web a `JSON.parse` SyntaxError quotes a slice of the
 * text it choked on, and that text is somebody's unsent report. That is also
 * why this module does not use the shared `resetCorruptKey`, which logs `err`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

import { serialize } from './serializedWrite';
import { scopedKey } from './userScope';

import {
  feedbackCategorySchema,
  feedbackControlSchema,
  feedbackImpactSchema,
  feedbackScreenSchema,
} from '@/api/schemas';

export const FEEDBACK_DRAFT_KEY = '@adepthood/feedback_draft';

const answersSchema = z.object({
  summary: z.string(),
  intent: z.string(),
  expected: z.string(),
  actual: z.string(),
});

/** A frozen request body, re-checked so a tampered row cannot become a request. */
const frozenPayloadSchema = z.object({
  category: feedbackCategorySchema,
  impact: feedbackImpactSchema,
  summary: z.string(),
  intent: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  context: z.object({
    screen: feedbackScreenSchema,
    control: feedbackControlSchema.optional(),
    platform: z.enum(['android', 'ios', 'web']),
    app_build: z.string(),
    viewport_class: z.enum(['compact', 'expanded', 'regular']),
    locale: z.string().optional(),
  }),
});

const storedFeedbackDraftSchema = z.object({
  category: feedbackCategorySchema.nullable(),
  impact: feedbackImpactSchema.nullable(),
  answers: answersSchema,
  idempotencyKey: z.string().min(1),
  attempt: z.object({ key: z.string().min(1), payload: frozenPayloadSchema }).nullable(),
});

export type StoredFeedbackDraft = z.infer<typeof storedFeedbackDraftSchema>;

const WARN_READ = '[feedback] could not read the saved draft; keeping it for next time';
const WARN_CORRUPT = '[feedback] the saved draft was unreadable and has been cleared';
const WARN_CLEAR = '[feedback] could not clear an unreadable saved draft';

function parseDraft(raw: string): StoredFeedbackDraft | null {
  try {
    const parsed = storedFeedbackDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function discardCorrupt(key: string): Promise<void> {
  console.warn(WARN_CORRUPT);
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    console.warn(WARN_CLEAR);
  }
}

/** What a read found: a draft, nothing, or a row it could not read this time. */
export type FeedbackDraftRead =
  { kind: 'draft'; draft: StoredFeedbackDraft } | { kind: 'empty' } | { kind: 'unreadable' };

async function readDraft(key: string): Promise<FeedbackDraftRead> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    console.warn(WARN_READ);
    return { kind: 'unreadable' };
  }
  if (raw === null) return { kind: 'empty' };
  const draft = parseDraft(raw);
  if (draft === null) {
    await discardCorrupt(key);
    return { kind: 'empty' };
  }
  return { kind: 'draft', draft };
}

/**
 * The storage key for the active account's draft, resolved NOW.
 *
 * A send can outlive its composer, its session and even its account: logout or
 * an account switch may finish while a keyed POST is still retrying. Callers
 * that write after an await therefore resolve this once, before the await, and
 * pass it back in -- so a late write can never land under whichever account
 * happens to be active by then.
 */
export function feedbackDraftKey(): string {
  return scopedKey(FEEDBACK_DRAFT_KEY);
}

/**
 * Read the draft, telling "there is none" apart from "it could not be read".
 *
 * A transient read failure keeps the row (a later read may recover it), and the
 * caller must not treat it as an empty slot to write a fresh draft into. A row
 * that is not a draft is removed so it cannot fail every future read.
 *
 * The read queues behind any write still in flight on the same key, so a
 * composer that remounts straight after a keystroke reads that keystroke back.
 */
export function readFeedbackDraft(key: string = feedbackDraftKey()): Promise<FeedbackDraftRead> {
  return serialize(key, () => readDraft(key));
}

/** The saved draft, or `null` when there is none or it could not be read. */
export async function loadFeedbackDraft(): Promise<StoredFeedbackDraft | null> {
  const read = await readFeedbackDraft();
  return read.kind === 'draft' ? read.draft : null;
}

/** Persist the draft. Rejects on a failed write so the caller can decide. */
export function saveFeedbackDraft(
  draft: StoredFeedbackDraft,
  key: string = feedbackDraftKey(),
): Promise<void> {
  return serialize(key, () => AsyncStorage.setItem(key, JSON.stringify(draft)));
}

/** Remove the draft: from `wipeUserState`, or under a key captured earlier. */
export function clearFeedbackDraft(key: string = feedbackDraftKey()): Promise<void> {
  return serialize(key, () => AsyncStorage.removeItem(key));
}

/**
 * Settle a sent attempt against what is stored NOW, atomically on the key's lane.
 *
 * `sent` removes the row; `unfreeze` drops only the attempt and keeps the answers
 * and key. Either applies only while the stored attempt is still the one that was
 * sent (`sentKey`): a composer reopened meanwhile may have discarded it with
 * "Edit report" and written new text under a new key, and an orphaned send from
 * the closed composer must not clear or rewrite that.
 */
export function settleFeedbackAttempt(
  key: string,
  sentKey: string,
  outcome: 'sent' | 'unfreeze',
): Promise<void> {
  return serialize(key, async () => {
    const read = await readDraft(key);
    if (read.kind !== 'draft' || read.draft.attempt?.key !== sentKey) return;
    if (outcome === 'sent') {
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, JSON.stringify({ ...read.draft, attempt: null }));
  });
}
