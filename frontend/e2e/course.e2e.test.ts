import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { ApiError, auth, course, setTokenGetter } from '@/api';
import type { ContentItem } from '@/api';
import { STAGE_DURATIONS_DAYS } from '@/constants/program';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_NOT_FOUND = 404;

// A fresh account is provisioned on stage 1 and has sat on it for one day, so
// the proportional drip is at its narrowest and every expectation below is
// derived from that rather than from a snapshot of today's chapter list.
const STAGE_NUMBER = 1;
const FIRST_DAY_IN_STAGE = 1;
const PERCENT = 100;
const PERCENT_DECIMALS = 2;
// The scheme the seeder writes into `StageContent.url` for vendored chapters.
const CONTENT_REF_PREFIX = 'content://';

const email = `e2e-course-${randomUUID()}${EMAIL_DOMAIN}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

/** Read an element the journey requires to be there, naming it when it is not. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected ${what} at position ${index}, but the list holds ${items.length}`);
  }
  return item;
}

/** Days the given 1-based stage lasts, per the frontend's own program table. */
function stageDurationDays(stageNumber: number): number {
  return at(STAGE_DURATIONS_DAYS, stageNumber - 1, 'a stage duration');
}

/**
 * Chapters the proportional drip has released by `day`.
 *
 * The server owns this formula; restating it here is the point. If the drip
 * changes on one side only, the two disagree and this lane says so.
 */
function releasedByDay(total: number, day: number, durationDays: number): number {
  return Math.min(total, Math.ceil((total * day) / durationDays));
}

/** The 1-based day the next locked chapter opens, inverting the drip. */
function nextUnlockDay(total: number, released: number, durationDays: number): number {
  return Math.floor((released * durationDays) / total) + 1;
}

/** Percentage the server reports, rounded the way its response schema rounds. */
function readPercent(read: number, total: number): number {
  return Number(((read / total) * PERCENT).toFixed(PERCENT_DECIMALS));
}

describe('course journey against a live server', () => {
  let sessionToken: string | null = null;
  let chapters: ContentItem[] = [];
  let releasedCount = 0;
  let lockedChapterId = 0;
  let completionId = 0;
  let completedAt = '';

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account so no other journey can perturb it', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: LICENSE_KEY,
    });

    expect(response.user_id).toBeGreaterThan(0);

    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
  });

  it('opens the stage as a chapter map with only the drip-released chapters unlocked', async () => {
    chapters = await course.stageContentAll(STAGE_NUMBER);

    expect(chapters.length).toBeGreaterThan(0);
    // The listing is the drip's sort key, so a reordering would silently move
    // which chapter is the openable one.
    const releaseDays = chapters.map((chapter) => chapter.release_day);
    expect(releaseDays).toEqual([...releaseDays].sort((left, right) => left - right));

    releasedCount = releasedByDay(
      chapters.length,
      FIRST_DAY_IN_STAGE,
      stageDurationDays(STAGE_NUMBER),
    );
    // Day one of a 21-day stage releases a prefix, never the whole stage: the
    // locked remainder is what the 404 mask below is asserted against.
    expect(releasedCount).toBeGreaterThan(0);
    expect(releasedCount).toBeLessThan(chapters.length);
    expect(chapters.map((chapter) => chapter.is_locked)).toEqual(
      chapters.map((_chapter, position) => position >= releasedCount),
    );
    // Nothing is read on a brand-new account, and locked rows surrender no url.
    expect(chapters.some((chapter) => chapter.is_read)).toBe(false);
    for (const locked of chapters.slice(releasedCount)) {
      expect(locked.url).toBeNull();
    }

    const openChapter = at(chapters, 0, 'the first released chapter');
    expect(openChapter.title.length).toBeGreaterThan(0);
    expect(openChapter.url).toEqual(expect.stringContaining(CONTENT_REF_PREFIX));

    lockedChapterId = at(chapters, releasedCount, 'the first still-locked chapter').id;
  });

  it('reports zero read progress and names the day the next chapter opens', async () => {
    const progress = await course.stageProgress(STAGE_NUMBER);

    // `total_items` is the whole stage, not the released prefix — the two
    // endpoints have to agree about how big the stage is.
    expect(progress.total_items).toBe(chapters.length);
    expect(progress.read_items).toBe(0);
    expect(progress.progress_percent).toBe(0);
    expect(progress.next_unlock_day).toBe(
      nextUnlockDay(chapters.length, releasedCount, stageDurationDays(STAGE_NUMBER)),
    );
  });

  it('serves the released chapter body the listing pointed at', async () => {
    const chapter = at(chapters, 0, 'the first released chapter');

    const body = await course.contentBody(chapter.id);

    expect(body.title).toBe(chapter.title);
    expect(body.content_type).toBe(chapter.content_type);
    // A 200 with an empty body is the failure this lane exists to catch.
    expect(body.body_markdown.trim().length).toBeGreaterThan(0);
  });

  it('masks a chapter the drip has not released as a 404 rather than serving it', async () => {
    const failure = await rejection(course.contentBody(lockedChapterId));

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(HTTP_NOT_FOUND);
    expect((failure as ApiError).detail).toBe('content_not_found');
  });

  it('marks the released chapter read and hands back the completion row', async () => {
    const chapter = at(chapters, 0, 'the first released chapter');

    const completion = await course.markRead(chapter.id);

    expect(completion.id).toBeGreaterThan(0);
    expect(completion.content_id).toBe(chapter.id);
    expect(Number.isNaN(Date.parse(completion.completed_at))).toBe(false);

    completionId = completion.id;
    completedAt = completion.completed_at;
  });

  it('returns the same completion when the same chapter is marked read again', async () => {
    const chapter = at(chapters, 0, 'the first released chapter');

    const repeat = await course.markRead(chapter.id);

    expect(repeat.id).toBe(completionId);
    expect(repeat.completed_at).toBe(completedAt);
  });

  it('moves the stage progress the server reports', async () => {
    const progress = await course.stageProgress(STAGE_NUMBER);

    expect(progress.total_items).toBe(chapters.length);
    expect(progress.read_items).toBe(1);
    expect(progress.progress_percent).toBe(readPercent(1, chapters.length));
    // Reading a chapter earns no time: the drip is still where it was.
    expect(progress.next_unlock_day).toBe(
      nextUnlockDay(chapters.length, releasedCount, stageDurationDays(STAGE_NUMBER)),
    );
  });

  it('shows that one chapter, and only that chapter, as read on a fresh listing', async () => {
    const chapter = at(chapters, 0, 'the first released chapter');

    const reread = await course.stageContentAll(STAGE_NUMBER);

    expect(reread.map((item) => item.id)).toEqual(chapters.map((item) => item.id));
    expect(reread.map((item) => item.is_read)).toEqual(
      reread.map((item) => item.id === chapter.id),
    );
    // Marking a chapter read must not shift the drip window either way.
    expect(reread.map((item) => item.is_locked)).toEqual(chapters.map((item) => item.is_locked));
  });
});
