/**
 * Flip one journal task's state character without touching any other source byte.
 *
 * ``lineStart`` is in the journal's canonical code-point coordinate space. The
 * shared classifier is the authority for whether that source line is a task and
 * where its box begins; this deliberately has no second task-marker regex.
 */
import { classifyLine, sourceLines } from './journalMarkdownLines';

/** Locate a task by stable document order, independent of preceding line length. */
function taskStartAtOrdinal(body: string, ordinal: number): number | null {
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  const chars = Array.from(body);
  let seen = 0;
  for (const source of sourceLines(chars)) {
    if (classifyLine(chars, source).kind !== 'task') continue;
    if (seen === ordinal) return source.start;
    seen += 1;
  }
  return null;
}

/** Resolve a source line to its task ordinal for rebasing queued presses. */
export function taskOrdinalAt(body: string, lineStart: number): number | null {
  const chars = Array.from(body);
  let ordinal = 0;
  for (const source of sourceLines(chars)) {
    const line = classifyLine(chars, source);
    if (line.kind !== 'task') continue;
    if (source.start === lineStart) return ordinal;
    ordinal += 1;
  }
  return null;
}

export function toggleTaskAt(body: string, lineStart: number): string {
  const chars = Array.from(body);
  const source = sourceLines(chars).find((line) => line.start === lineStart);
  if (source == null) return body;
  const line = classifyLine(chars, source);
  if (line.kind !== 'task') return body;
  const state = line.markerEnd + 1;
  chars[state] = line.taskChecked === true ? ' ' : 'x';
  return chars.join('');
}

/** Reapply a queued task intent after the server has changed preceding text. */
export function toggleTaskAtOrdinal(body: string, ordinal: number): string {
  const lineStart = taskStartAtOrdinal(body, ordinal);
  return lineStart == null ? body : toggleTaskAt(body, lineStart);
}
