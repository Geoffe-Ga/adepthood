/**
 * Join a transcribed handwritten page onto the writing already on an entry.
 *
 * The rule is deliberately conservative. Transcription is a real-money read the
 * writer paid for, and the prose above it is theirs: neither is reformatted,
 * re-punctuated or re-wrapped here. All this decides is the seam between them —
 * one blank line, the same gap a writer would leave by hand — and it makes the
 * two degenerate cases read naturally rather than as a stray gap: a page opened
 * blank (a Course reflection photographed before a word is typed) begins with
 * the transcript itself, and an empty transcript leaves the page exactly as it
 * was rather than tacking whitespace onto the end of it.
 */

/** The gap between the writing already on the page and the page just read. */
export const TRANSCRIPT_SEPARATOR = '\n\n';

/**
 * Return `body` with `transcript` appended below it.
 *
 * Trailing whitespace on `body` is collapsed into the single separator so a
 * writer who left the caret on a blank line gets one gap rather than three.
 */
export function appendTranscript(body: string, transcript: string): string {
  if (!transcript.trim()) return body;
  if (!body.trim()) return transcript;
  return `${body.trimEnd()}${TRANSCRIPT_SEPARATOR}${transcript}`;
}
