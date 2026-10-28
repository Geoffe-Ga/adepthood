import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { runBackendModule } from './laneDatabase';
import { freshLicenseKey } from './licenseKey';

import { auth, course, setTokenGetter } from '@/api';
import type { ContentItem, NextUnread, SiteResource } from '@/api';
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

/** The wire shape "Read next" names for a chapter. */
function chapterTarget(chapter: ContentItem, stageNumber: number): NextUnread {
  return {
    kind: 'chapter',
    slug: null,
    content_id: chapter.id,
    stage_number: stageNumber,
    title: chapter.title,
  };
}

/** The wire shape "Read next" names for a Start Here resource. */
function resourceTarget(resource: SiteResource): NextUnread {
  return {
    kind: 'resource',
    slug: resource.slug,
    content_id: null,
    stage_number: null,
    title: resource.title,
  };
}

/**
 * "Read next" (#3147, #3234): every unread Start Here resource in reading order
 * first, then the earliest unlocked, unread chapter across open stages.
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
  let startHere: SiteResource[] = [];

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
    startHere = await course.siteResources();
    // At least two resources, or "the next one" below would prove nothing.
    expect(startHere.length).toBeGreaterThan(1);
  });

  it('points a reader who has read nothing at the first Start Here resource', async () => {
    const first = at(startHere, 0, 'the first Start Here resource');

    expect(await course.nextUnread()).toEqual(resourceTarget(first));
    // What the button opens has to be readable, not merely named.
    const body = await course.siteResourceBody(first.slug);
    expect(body.body_markdown.trim().length).toBeGreaterThan(0);
  });

  it('walks Start Here in reading order, then hands over to the first Beige chapter', async () => {
    await course.markResourceRead(at(startHere, 0, 'the first Start Here resource').slug);
    expect(await course.nextUnread()).toEqual(
      resourceTarget(at(startHere, 1, 'the second Start Here resource')),
    );

    for (const resource of startHere.slice(1)) {
      await course.markResourceRead(resource.slug);
    }
    expect(await course.nextUnread()).toEqual(
      chapterTarget(at(beige, 0, 'the first Beige chapter'), BEIGE),
    );
  });

  it('moves to chapter 2 once chapter 1 is marked read, and serves its reader', async () => {
    await course.markRead(at(beige, 0, 'the first Beige chapter').id);
    const second = at(beige, 1, 'the second Beige chapter');

    expect(await course.nextUnread()).toEqual(chapterTarget(second, BEIGE));
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

    expect(await course.nextUnread()).toEqual(chapterTarget(firstPurple, PURPLE));
  });
});
