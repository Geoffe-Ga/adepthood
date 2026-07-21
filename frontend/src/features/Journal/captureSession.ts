/**
 * The ordered multi-page capture session for the Journal photograph flow: a pure
 * reducer over a list of picked pages that a writer collects, reorders, and trims
 * before transcribing. A session is a working set held only in component state.
 *
 * PRIVACY: each page carries its base64 image; that payload lives in reducer
 * state only, is never logged, and is released when the session is cleared or the
 * screen unmounts.
 */
import type { MediaType } from '@/api';

/** A session holds at most this many pages; beyond it, the writer saves and starts anew. */
export const MAX_PAGES_PER_SESSION = 10;

/** A page's lifecycle marker. Only `ready` exists today; later epics widen it. */
export type CapturePageStatus = 'ready';

/** One collected page: a stable id, its transient device files, and the
 *  prepared (downscaled) base64 to transcribe. */
export interface CapturePage {
  id: string;
  /** The original picker/camera cache copy the page was prepared from. */
  sourceUri: string;
  /** The downscaled manipulator-output file — also the thumbnail source. */
  uri: string;
  imageBase64: string;
  /** Decoded size of {@link imageBase64}, gating oversize uploads on device. */
  byteLength: number;
  /** Always `image/jpeg` in practice — the prepare step's one save format. */
  mediaType: MediaType;
  status: CapturePageStatus;
}

/**
 * The transitions a capture session accepts:
 *
 *  - `append`  — add a freshly-picked batch after the existing pages.
 *  - `remove`  — drop the page with the given id.
 *  - `reorder` — replace the order wholesale (from a drag end).
 *  - `clear`   — empty the session (on save, offramp, or fresh start).
 */
export type CaptureSessionAction =
  | { type: 'append'; pages: readonly CapturePage[] }
  | { type: 'remove'; id: string }
  | { type: 'reorder'; pages: readonly CapturePage[] }
  | { type: 'clear' };

/**
 * Advance the session by one action, returning a new page list.
 *
 * `append` is additive and clamps the result to {@link MAX_PAGES_PER_SESSION}:
 * existing pages are kept and incoming pages are appended in order until the cap
 * is reached, dropping any overflow. `remove` filters by id preserving order,
 * `reorder` takes the supplied order verbatim, and `clear` empties the session.
 */
export function captureSessionReducer(
  state: CapturePage[],
  action: CaptureSessionAction,
): CapturePage[] {
  switch (action.type) {
    case 'append': {
      const room = Math.max(MAX_PAGES_PER_SESSION - state.length, 0);
      return [...state, ...action.pages.slice(0, room)];
    }
    case 'remove':
      return state.filter((page) => page.id !== action.id);
    case 'reorder':
      return [...action.pages];
    case 'clear':
      return [];
    default:
      return state;
  }
}

/** Whether the session has room for at least one more page. */
export function canAddPages(pages: readonly CapturePage[]): boolean {
  return pages.length < MAX_PAGES_PER_SESSION;
}

/** Warm, declinable copy shown once a session is full — save and start another. */
export const capReachedCopy = `Sessions hold up to ${MAX_PAGES_PER_SESSION} pages — save this entry and start another for more.`;
