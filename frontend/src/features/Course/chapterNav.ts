import type { ContentItem } from '../../api';

/** View-model for the chapter reader's Back/Next footer buttons. */
export interface ChapterNav {
  canPrev: boolean;
  nextIsDone: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/** Adjacent chapters around the current item, plus whether Next ends the run. */
export interface ChapterNeighbors {
  prev: ContentItem | null;
  next: ContentItem | null;
  nextIsDone: boolean;
}

/** Resolve the prev/next chapters around ``currentId`` within ``content``. */
export function deriveChapterNeighbors(
  content: ContentItem[],
  currentId: number,
): ChapterNeighbors {
  const index = content.findIndex((c) => c.id === currentId);
  const prev = index > 0 ? (content[index - 1] ?? null) : null;
  const next = index >= 0 && index < content.length - 1 ? (content[index + 1] ?? null) : null;
  const nextIsDone = next === null || next.is_locked;
  return { prev, next, nextIsDone };
}
