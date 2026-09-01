import { randomUUID } from 'node:crypto';

import { describe, afterAll, expect, it } from '@jest/globals';

import { auth, practiceTags, setTokenGetter } from '@/api';
import type { PracticeTag } from '@/api';

/**
 * Renaming and deleting one of your own practice tags, across the wire.
 *
 * Both routes have been served and typed for a long time with nothing calling
 * them: the recipe editor's tag library could list and create, and stopped
 * there. The half that matters at the seam is that the id the library sends is
 * the row the server changes, that a rename is visible on the very next list
 * rather than only in local state, that the slug survives a rename (recipe
 * steps copy it by value), and that a shared tag is refused with the server's
 * own 403 rather than by anything the client chose not to render.
 *
 * The system-tag refusals run before the personal delete, against live rows, so
 * a refusal that quietly mutated something is caught by the list that follows.
 */

// `@example.test` is a reserved TLD the signup validator rejects with 422.
const EMAIL_DOMAIN = '@example.com';
const PASSWORD = 'correct horse battery staple'; // pragma: allowlist secret
const TIMEZONE = 'UTC';
const LICENSE_KEY = 'e2e-license';
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

const email = `e2e-practice-tags-${randomUUID()}${EMAIL_DOMAIN}`;
// Slug is machine-facing and constrained; the label is the part a person reads,
// so it carries non-ASCII the rename has to move through intact.
const slug = `e2e_tag_${randomUUID().replaceAll('-', '_')}`;
const originalLabel = `Vela 灯 ${randomUUID()}`;
const renamedLabel = `Candela 燈 ${randomUUID()}`;

/** Resolve with whatever a request rejected with; fail if it resolved instead. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('expected the request to reject, but it resolved');
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: number }).status
    : undefined;
}

function findBySlug(tags: readonly PracticeTag[], wanted: string): PracticeTag | undefined {
  return tags.find((tag) => tag.slug === wanted);
}

describe('practice-tag library journey against a live server', () => {
  let sessionToken: string | null = null;
  let tagId = 0;
  let systemTagId = 0;

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

  it('creates a personal tag beside the seeded system library', async () => {
    const created = await practiceTags.create({ slug, label: originalLabel });

    expect(created.id).toBeGreaterThan(0);
    expect(created.slug).toBe(slug);
    expect(created.label).toBe(originalLabel);
    // The server owns this field; a client cannot mint a system tag.
    expect(created.owner_user_id).toBeGreaterThan(0);

    tagId = created.id;

    const listed = await practiceTags.list();
    expect(findBySlug(listed, slug)?.label).toBe(originalLabel);
    const system = listed.find((tag) => tag.owner_user_id === null);
    if (system === undefined) throw new Error('expected the seeded system tags to be visible');
    systemTagId = system.id;
  });

  it('renames the tag and keeps its slug, as the next list confirms', async () => {
    const renamed = await practiceTags.update(tagId, { label: renamedLabel });

    expect(renamed.id).toBe(tagId);
    expect(renamed.label).toBe(renamedLabel);
    // Immutable by contract: a recipe step holds this string by value.
    expect(renamed.slug).toBe(slug);

    // Read it back rather than trusting the write's own echo.
    const listed = await practiceTags.list();
    expect(findBySlug(listed, slug)?.label).toBe(renamedLabel);
  });

  it('refuses both mutations on a tag the account does not own', async () => {
    const renameFailure = await rejection(
      practiceTags.update(systemTagId, { label: 'not mine to name' }),
    );
    const deleteFailure = await rejection(practiceTags.remove(systemTagId));

    expect(statusOf(renameFailure)).toBe(HTTP_FORBIDDEN);
    expect(statusOf(deleteFailure)).toBe(HTTP_FORBIDDEN);

    // And the refusals changed nothing: the shared row is still listed.
    const listed = await practiceTags.list();
    expect(listed.some((tag) => tag.id === systemTagId)).toBe(true);
    expect(findBySlug(listed, slug)?.label).toBe(renamedLabel);
  });

  it('deletes the personal tag and stops serving it', async () => {
    await practiceTags.remove(tagId);

    const listed = await practiceTags.list();
    expect(findBySlug(listed, slug)).toBeUndefined();
    // The shared library is untouched by a personal delete.
    expect(listed.some((tag) => tag.id === systemTagId)).toBe(true);

    const readBack = await rejection(practiceTags.update(tagId, { label: 'gone' }));
    expect(statusOf(readBack)).toBe(HTTP_NOT_FOUND);
  });
});
