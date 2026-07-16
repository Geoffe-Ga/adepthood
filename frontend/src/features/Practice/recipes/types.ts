/**
 * Shared types for the recipe picker + editor.
 *
 * The wire shapes themselves live in `@/api`; the editor's working
 * shape is a draft step (no `position` field -- the editor's array
 * index defines order at save time, the same convention the backend
 * uses for `PracticeRecipeStepInput`).
 */

import { slugifyCore } from '../utils/slugify';

import type { RecipeMode } from '@/api';

export type { RecipeMode };

export interface DraftStep {
  /** Stable client-side id so React's key prop survives reordering. */
  uid: string;
  tag_slug: string;
  tag_label: string;
  prompt_label: string;
  target_count: number;
}

export interface RecipeDraft {
  /** Empty string while creating a new recipe; populated on edit. */
  slug: string;
  name: string;
  description: string;
  mode: RecipeMode;
  rounds: number;
  steps: DraftStep[];
}

/**
 * Lower-cap snake-case conversion used when minting a slug from a
 * recipe name on create.  Mirrors the backend pattern
 * `^[a-z][a-z0-9_]*$`; characters outside [a-z0-9] collapse to `_`,
 * leading non-alpha is prefixed with `r_`, empty result becomes
 * `untitled`.
 */
export function nameToSlug(name: string): string {
  const cleaned = slugifyCore(name);
  if (cleaned.length === 0) return 'untitled';
  if (!/^[a-z]/.test(cleaned)) return `r_${cleaned}`;
  return cleaned;
}

let _uidCounter = 0;
export function newStepUid(): string {
  _uidCounter += 1;
  return `step_${Date.now()}_${_uidCounter}`;
}
