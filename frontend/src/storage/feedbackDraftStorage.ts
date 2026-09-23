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

import { feedbackCategorySchema, feedbackImpactSchema } from '@/api/schemas';

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
    screen: z.string(),
    control: z.string().optional(),
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

async function readDraft(key: string): Promise<StoredFeedbackDraft | null> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    console.warn(WARN_READ);
    return null;
  }
  if (raw === null) return null;
  const draft = parseDraft(raw);
  if (draft === null) await discardCorrupt(key);
  return draft;
}

/**
 * The saved draft, or `null`. A transient read failure keeps the row (a later
 * read may recover it); a row that is not a draft is removed so it cannot fail
 * every future read.
 *
 * The read queues behind any write still in flight on the same key, so a
 * composer that remounts straight after a keystroke reads that keystroke back.
 */
export function loadFeedbackDraft(): Promise<StoredFeedbackDraft | null> {
  const key = scopedKey(FEEDBACK_DRAFT_KEY);
  return serialize(key, () => readDraft(key));
}

/** Persist the draft. Rejects on a failed write so the caller can decide. */
export function saveFeedbackDraft(draft: StoredFeedbackDraft): Promise<void> {
  const key = scopedKey(FEEDBACK_DRAFT_KEY);
  return serialize(key, () => AsyncStorage.setItem(key, JSON.stringify(draft)));
}

/** Remove the draft: after a confirmed receipt, and from `wipeUserState`. */
export function clearFeedbackDraft(): Promise<void> {
  const key = scopedKey(FEEDBACK_DRAFT_KEY);
  return serialize(key, () => AsyncStorage.removeItem(key));
}
