import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { freshLicenseKey } from './licenseKey';

import { auth, course, setTokenGetter } from '@/api';
import type { ContentItem } from '@/api';
import { STAGE_DURATIONS_DAYS } from '@/constants/program';

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const BEIGE = 1;
const PURPLE = 2;
const ANCHOR_MODULE = 'tests.e2e.program_anchor';

const email = `e2e-course-read-next-${randomUUID()}${EMAIL_DOMAIN}`;

/** Read an element the journey requires to be there, naming it when it is not. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected ${what} at position ${index}, but the list holds ${items.length}`);
  }
  return item;
}

/**
 * "Read next" (#3147): the earliest unlocked, unread chapter across open stages.
 *
 * The account is moved one whole Beige window into the program so Beige is
 * fully released and Purple has opened: day one of a fresh account releases a
 * single chapter, which would leave no "chapter 2" to land on. The only thing
 * arranged out of band is the passage of time (`tests.e2e.program_anchor`);
 * every read below goes through the unmocked production client. The tap on the
 * button itself is pinned in-process by
 * `src/features/Course/__tests__/CourseScreenReadNext.test.tsx`.
 */
describe('read next against a live server', () => {
  let sessionToken: string | null = null;
  let beige: ContentItem[] = [];

  afterAll(() => {
    setTokenGetter(null);
  });

  it('registers its own account and lets one Beige window pass', async () => {
    const response = await auth.signup({
      email,
      password: PASSWORD,
      timezone: TIMEZONE,
      license_key: freshLicenseKey(),
    });
    sessionToken = response.token;
    setTokenGetter(() => sessionToken);
    const beigeDays = at(STAGE_DURATIONS_DAYS, BEIGE - 1, 'the Beige duration');
    runBackendModule(ANCHOR_MODULE, ['anchor', '--email', email, '--days-ago', String(beigeDays)]);

    beige = await course.stageContentAll(BEIGE);
    // At least two open chapters, or "chapter 2" below would prove nothing.
    expect(beige.length).toBeGreaterThan(1);
    expect(beige.every((chapter) => !chapter.is_locked)).toBe(true);
  });

  it('points a reader who has read nothing at the first Beige chapter', async () => {
    const first = at(beige, 0, 'the first Beige chapter');

    expect(await course.nextUnread()).toEqual({
      content_id: first.id,
      stage_number: BEIGE,
      title: first.title,
    });
  });

  it('moves to chapter 2 once chapter 1 is marked read, and serves its reader', async () => {
    await course.markRead(at(beige, 0, 'the first Beige chapter').id);
    const second = at(beige, 1, 'the second Beige chapter');

    expect(await course.nextUnread()).toEqual({
      content_id: second.id,
      stage_number: BEIGE,
      title: second.title,
    });
    // What the button opens has to be readable, not merely named.
    const body = await course.contentBody(second.id);
    expect(body.body_markdown.trim().length).toBeGreaterThan(0);
  });

  it('crosses into the next open stage once every Beige chapter is read', async () => {
    for (const chapter of beige.slice(1)) {
      await course.markRead(chapter.id);
    }
    const purple = await course.stageContentAll(PURPLE);
    const firstPurple = at(purple, 0, 'the first Purple chapter');
    expect(firstPurple.is_locked).toBe(false);

    expect(await course.nextUnread()).toEqual({
      content_id: firstPurple.id,
      stage_number: PURPLE,
      title: firstPurple.title,
    });
  });
});
