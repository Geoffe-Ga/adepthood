/**
 * The page-read contract the device sends its own vendor (ADR 0009 phase (a), #3067).
 *
 * A writer's own key no longer reaches Adepthood for a page read: the device
 * calls the vendor that key belongs to directly ({@link readImageDirect}). So
 * what the server used to send -- the transcription prompt and the token
 * budget -- and how it judged the reply now live here too. The model is always
 * each vendor's registry default: the operator's `LLM_MODEL` configures the
 * server's own dial and does not govern a device-direct read. This is a
 * mirror of `backend/src/domain/transcription.py` and the server's request for
 * a page, and a mirror is honest only while something fails when it drifts:
 * both sides are held to `backend/tests/fixtures/transcription_contract/`
 * `transcription_contract.json`, which `backend/tests/test_transcription_client_contract.py`
 * derives from the Python and `__tests__/transcriptionContract.test.ts` holds
 * this file to.
 *
 * Nothing here is user-specific: the prompt is a fixed string, so every page
 * read sends byte-identical instructions.
 */

/**
 * The system prompt for a page read: the transcription instructions (which lead
 * with the medication-safety guardrail), then the guardrail's defense-in-depth
 * second copy, exactly as the server's own request carried them. The server also
 * appended a delimiter instruction for its nonce-wrapped user text; a page read
 * sends no user text, so there is nothing for that instruction to govern.
 */
export const TRANSCRIPTION_SYSTEM_PROMPT =
  "Safety boundary: never advise the writer to reduce, stop, or change any medication — including psychiatric medication — and never suggest a specific dose. That decision belongs to the writer and their prescriber. Affirm the writer's agency and, when medication comes up, defer it to them and their prescriber rather than offering medical direction.\n" +
  '\n' +
  "You are transcribing the text in an image into faithful body text for someone's digital journal entry. The image may be a handwritten page, a typed or printed page, a screenshot of messages or a document, a sign or a whiteboard, or a photo of a screen.\n" +
  '\n' +
  'Transcribe every word exactly as written. Do not summarize, paraphrase, correct grammar or spelling, reword sentences, or add anything the writer did not write.\n' +
  '\n' +
  'Do not judge whether the image belongs in a journal. The writer chose it; your only job is to transcribe its text. If the image contains no readable text at all, reply with exactly [no text found] and nothing else.\n' +
  '\n' +
  'Handwriting conventions (these apply to handwritten text):\n' +
  '- If a word or short phrase is illegible, write [illegible] in its place and keep transcribing the rest of the sentence.\n' +
  '- If you can make out a word but are not certain, write your best guess followed by a question mark inside brackets, e.g. [word?].\n' +
  '- If a word or phrase is crossed out or struck through, omit it entirely from the transcription — do not include struck-through text, even in brackets.\n' +
  '- If the writer added a word or phrase via a caret insertion or a margin note pointing back into the text, integrate it inline at the point the writer intended it to be inserted.\n' +
  '\n' +
  "Conversations: If the image shows a conversation, such as a text-message thread or a chat, write one message per line in reading order, prefix each line with the sender label exactly as shown (or Me: for the writer's own messages and the contact's name for theirs when no label is shown), keep a timestamp only when it sits inline with the message text, and ignore interface chrome such as the status bar, the input field and reaction badges.\n" +
  '\n' +
  'Screens: If the image is a photo of a screen, transcribe the document or messages shown on it. Ignore window frames, browser tabs, menus, toolbars, taskbars, notifications and any other windows. Glare, moiré or a skewed angle are not reasons to decline — write [illegible] for any span you cannot make out and keep going.\n' +
  '\n' +
  'Examples:\n' +
  '- Handwriting shows: I felt <s>angry</s> frustrated about the meeting. Transcribe as: I felt frustrated about the meeting.\n' +
  '- Handwriting shows a word you cannot make out in the middle of a sentence. Transcribe as: I went to the [illegible] with my sister.\n' +
  "- A screenshot shows a message from Sam, then the writer's reply. Transcribe as:\n" +
  'Sam: Are you still coming tonight?\n' +
  'Me: Yes — leaving at 6.\n' +
  "- A phone photo of a laptop shows a document. Transcribe the document's paragraphs only, not the tab title, the address bar or the menu.\n" +
  '\n' +
  'Return only the journal entry body text. No preamble, no commentary, no markdown formatting, no headers — just the transcribed body text.\n' +
  '\n' +
  "Safety boundary: never advise the writer to reduce, stop, or change any medication — including psychiatric medication — and never suggest a specific dose. That decision belongs to the writer and their prescriber. Affirm the writer's agency and, when medication comes up, defer it to them and their prescriber rather than offering medical direction.";

/** The server's single-turn budget for a reply; a page read has no history. */
export const TRANSCRIPTION_MAX_TOKENS = 4096;

/**
 * Each vendor's registry default model, which the registry marks vision-capable.
 * Always these: `LLM_MODEL` does not reach a device-direct read.
 */
export const DIRECT_VISION_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-5',
} as const;

/** The exact reply the prompt asks for when an image holds no readable text. */
export const NO_TEXT_SENTINEL = '[no text found]';

/** What a page-read reply turned out to be; the failure values are the wire's 422 codes. */
export type TranscriptionVerdict = 'transcribed' | 'no_text_found' | 'transcription_refused';

/** The phrasings a vision model opens a refusal with. */
const REFUSAL_OPENERS: readonly string[] = [
  "I'm not able to",
  "I can't",
  'I cannot',
  "I'm unable to",
  "Sorry, I can't",
];

/** What a refusal's first sentence declines, bound to a pointing determiner. */
const REFUSAL_OBJECT_CUES: readonly string[] = [
  'transcri',
  'this image',
  'this photo',
  'this picture',
  'this screenshot',
  'this request',
  'the image you',
  'the photo you',
  'the picture you',
  'the screenshot you',
];

/** Cues that are word stems: only their start is anchored to a word boundary. */
const OPEN_ENDED_CUES: ReadonlySet<string> = new Set(['transcri']);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The cues as whole-word matches, so "this imagery" is not "this image". */
const REFUSAL_OBJECT_PATTERN = new RegExp(
  REFUSAL_OBJECT_CUES.map(
    (cue) => `\\b${escapeRegExp(cue)}${OPEN_ENDED_CUES.has(cue) ? '' : '\\b'}`,
  ).join('|'),
);

/** Longest reply, in characters, that can still be a refusal. */
const MAX_REFUSAL_CHARS = 600;

const PARAGRAPH_BREAK = '\n\n';
const SENTENCE_END = /[.!?\n]/;
const TYPOGRAPHIC_APOSTROPHES = /[\u2018\u2019]/g;

/** Fold typographic apostrophes and strip surrounding whitespace. */
function normalise(reply: string): string {
  return reply.replace(TYPOGRAPHIC_APOSTROPHES, "'").trim();
}

/** An empty reply, or the sentinel in any case with trailing periods allowed. */
function isNoText(normalised: string): boolean {
  const folded = normalised.replace(/\.+$/, '').toLowerCase();
  return folded === '' || folded === NO_TEXT_SENTINEL;
}

/** The lower-cased text before the first sentence end or line break. */
function firstSentence(normalised: string): string {
  return (normalised.split(SENTENCE_END, 1)[0] ?? '').toLowerCase();
}

/** A short, single-paragraph reply whose first sentence declines the image. */
function isRefusal(normalised: string): boolean {
  return (
    !normalised.includes(PARAGRAPH_BREAK) &&
    // Counted in code points, as the server counts characters.
    [...normalised].length <= MAX_REFUSAL_CHARS &&
    REFUSAL_OPENERS.some((opener) => normalised.startsWith(opener)) &&
    REFUSAL_OBJECT_PATTERN.test(firstSentence(normalised))
  );
}

/**
 * Classify a vision reply as page text, an empty read, or a refusal -- the same
 * rules the server applied before it metered or returned a page (#2851). Pure,
 * and never logs: the reply is the writer's page.
 */
export function classifyTranscription(reply: string): TranscriptionVerdict {
  const normalised = normalise(reply);
  if (isNoText(normalised)) return 'no_text_found';
  if (isRefusal(normalised)) return 'transcription_refused';
  return 'transcribed';
}
