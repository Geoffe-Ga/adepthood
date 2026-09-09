/**
 * The hand-off seam between the photograph-capture route and the journal entry
 * that sent the writer there.
 *
 * ``JournalPhotographScreen`` opened from the Journal shelf saves a NEW entry.
 * Opened from a page already being written — a Course reflection, say — the
 * transcribed page has to land in THAT page instead, under the title and the
 * save context the writer arrived with. The entry is often not on the server
 * yet when capture starts (a reflection photographed before a word is typed has
 * no id to append to), so the transcript travels back into the open editor and
 * is persisted by the entry's own create-then-update writer: one entry, one
 * write path, no second charge, and no chance of the still-mounted editor
 * overwriting a body that was patched behind its back.
 *
 * PRIVACY: the prose lives here in memory only, for the single hop between the
 * two screens. It never rides in navigation params (which are held in
 * navigation state for the life of the stack), it is retracted the moment the
 * entry collects it, and ``registerStoreReset`` wipes it at logout so an
 * undelivered page cannot outlive the session that produced it.
 *
 * Deliveries are ADDRESSED. A stack can hold more than one journal entry
 * (``startNew`` pushes a second), and every mounted entry sees this store — an
 * unaddressed transcript would be appended by all of them. The requesting entry
 * mints a token via {@link CapturedTranscriptState.open}, carries it on the
 * capture route's params, and collects only the delivery bearing that token.
 */
import { create } from 'zustand';

import { registerStoreReset } from './registry';

/** A transcript waiting to be collected, and the hand-off it belongs to. */
export interface PendingTranscript {
  /** The hand-off token the requesting entry minted; only it may collect this. */
  token: string;
  /** The merged, writer-edited transcript of the captured pages. */
  text: string;
}

export interface CapturedTranscriptState {
  /** How many hand-offs have been opened; the source of each token's number. */
  issued: number;
  /** The transcript awaiting collection, or null when there is none. */
  pending: PendingTranscript | null;
  /**
   * Begin a hand-off and return its token. Any transcript an earlier hand-off
   * never collected is dropped here rather than left to be mistaken for this
   * one's — the writer is starting a fresh capture, so the stale page is gone.
   */
  open: () => string;
  /** Publish `text` to the hand-off opened under `token`. */
  deliver: (_token: string, _text: string) => void;
  /** Retract the pending transcript, so it is collected exactly once. */
  clear: () => void;
}

/** Token prefix; the number after it is the hand-off's ordinal in this session. */
const TOKEN_PREFIX = 'capture-';

export const useCapturedTranscriptStore = create<CapturedTranscriptState>((set, get) => ({
  issued: 0,
  pending: null,

  open: () => {
    const issued = get().issued + 1;
    set({ issued, pending: null });
    return `${TOKEN_PREFIX}${issued}`;
  },
  deliver: (token, text) => {
    set({ pending: { token, text } });
  },
  clear: () => {
    set({ pending: null });
  },
}));

registerStoreReset(() => {
  useCapturedTranscriptStore.getState().clear();
});
