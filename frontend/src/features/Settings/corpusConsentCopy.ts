/**
 * Everything the corpus-consent screen says, in one file so it can be checked.
 *
 * This is the surface where somebody decides whether their own writing gets
 * sorted into a store the app reads back to them. Two rules follow from that,
 * and both are held by tests rather than by good intentions.
 *
 * **It says what the code does, and nothing more.** Every promise here is one
 * the backend keeps: the default is off, agreeing sends each entry to the
 * model provider once as it is saved, withdrawing deletes what was collected,
 * and an Intimate entry is never sorted at all. Nothing here describes
 * encryption, retention windows, or who can read the store — those belong to
 * the published policy, and a screen that improvises them is inventing a
 * guarantee somebody may rely on.
 *
 * **It does not sell.** Off is a complete answer. Reflections work without any
 * of this by reading recent entries, so no line here implies a diminished app,
 * a missed opportunity, or a decision still owed.
 */

/** What an account has decided about one source, as the screen needs it. */
export interface CorpusConsentDecision {
  readonly source: string;
  readonly granted: boolean;
  readonly decided_at: string | null;
}

export const CORPUS_CONSENT_EYEBROW = 'Your corpus';
export const CORPUS_CONSENT_TITLE = 'Writing reflections can draw on';

/** The offer, with declining stated as a whole answer rather than a deferral. */
export const CORPUS_CONSENT_LEAD =
  'A reflection can quote a few passages of your own earlier writing back to you. For that, ' +
  'your writing has to be sorted first — and nothing is sorted unless you turn it on here. ' +
  'Leaving it off is a complete answer: reflections read your recent entries instead, and the ' +
  'rest of the app is unchanged.';

/** Heading over the two consequences, so neither is discovered afterwards. */
export const CORPUS_CONSENT_CONSEQUENCE_HEADING = 'What turning one on does';

/** The first consequence: sorting is a model call, once per save. */
export const CORPUS_CONSENT_CONSEQUENCE_SENDING =
  'Each entry you save is sent once to the language-model provider to be sorted — one call as ' +
  'it is saved, and one more if you go back and change its wording or its tier.';

/** The second: withdrawing is a deletion, not a preference. */
export const CORPUS_CONSENT_CONSEQUENCE_REMOVAL =
  'Turning it back off deletes what it collected. Those copies are removed rather than hidden, ' +
  'and your entries stay in your journal untouched.';

/** The tier guarantee, restated here because this is where it is doubted. */
export const CORPUS_CONSENT_INTIMATE_LINE =
  'An entry you marked Intimate is never sorted, whatever you choose below.';

/** What the audit log holds — a decision, and none of the writing. */
export const CORPUS_CONSENT_RECORD_LINE =
  'What you choose is kept as a dated record: which kind of material, what you decided, and ' +
  'when. That record holds none of your words.';

/** Section heading over the per-source rows. */
export const CORPUS_CONSENT_SOURCES_HEADING = 'Kinds of material';

/** Asked before a withdrawal, because the switch is also a delete button. */
export const CORPUS_REVOKE_PROMPT =
  'This deletes the copies already sorted from this material. They cannot be brought back — ' +
  'not by you, not by support. Your entries stay in your journal exactly as they are.';

export const CORPUS_REVOKE_CONFIRM_LABEL = 'Turn it off and delete the copies';
export const CORPUS_REVOKE_CANCEL_LABEL = 'Leave it on';

/** Shown for a source no part of this app puts anything into yet. */
export const CORPUS_NOT_SORTED_YET_NOTE =
  'Nothing is sorted from here yet, so there is nothing to agree to. It becomes a switch once ' +
  'there is.';

/** Said when a read or a write did not reach the server. */
export const CORPUS_CONSENT_FAILURE =
  'That did not reach the server, so nothing changed. Check your connection and try again.';

/** The Settings row that leads here. */
export const CORPUS_CONSENT_ROW_LABEL = 'What reflections draw on';
export const CORPUS_CONSENT_ROW_DESCRIPTION =
  'Choose whether your own writing is sorted for reflections to quote. Off unless you turn it on.';

/** One source's name and what it covers, in the reader's language. */
export interface CorpusSourceCopy {
  readonly label: string;
  readonly description: string;
}

/**
 * The sources the API serves today, named as material rather than as columns.
 *
 * ``corpusConsentCopy.test.ts`` holds this to the enum the exported schema
 * publishes, so a source the server starts serving cannot reach the screen as
 * a bare token like ``import``.
 */
export const CORPUS_SOURCE_COPY: Record<string, CorpusSourceCopy> = {
  journal: {
    label: 'What you write in Adepthood',
    description: 'The entries you write here, apart from any you marked Intimate.',
  },
  upload: {
    label: 'Documents you bring in',
    description: 'Files you hand over through "Bring in your writing".',
  },
  import: {
    label: 'Writing from somewhere else',
    description: 'Material pulled in from another service you write on.',
  },
};

/**
 * The sources something in this app actually writes fragments for.
 *
 * A switch for material nothing collects would gather permission for an act
 * that cannot happen — and would still be granted on the day it can, without
 * anybody being asked again. So a source outside this list is shown and
 * explained, and offered no switch. ``corpusConsentCopy.test.ts`` derives the
 * same list from the backend, so adding a writer turns that test red until the
 * surface catches up.
 */
export const SOURCES_ADEPTHOOD_SORTS: readonly string[] = ['journal'];

/** Copy for a source the server serves and this release has not met. */
function unknownSourceCopy(source: string): CorpusSourceCopy {
  return {
    label: source,
    description: 'A kind of material this version of the app cannot describe yet.',
  };
}

/** One source's copy, never undefined — an unnamed source still gets a row. */
export function sourceCopy(source: string): CorpusSourceCopy {
  return CORPUS_SOURCE_COPY[source] ?? unknownSourceCopy(source);
}

/** Whether this app has anything to put into the corpus under ``source``. */
export function sortsAnything(source: string): boolean {
  return SOURCES_ADEPTHOOD_SORTS.includes(source);
}

/** ``short`` month/day/year (e.g. "Aug 18, 2026"); empty if unparseable. */
function formatDecisionDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The line under a source's name: its state, and when it was chosen.
 *
 * "Never asked" and "answered no" read differently on purpose. They are the
 * same switch position and a different fact about the person, and collapsing
 * them would let a screen tell somebody who declined that the question is still
 * open.
 */
export function consentStatusLine(decision: CorpusConsentDecision): string {
  const when = decision.decided_at === null ? '' : formatDecisionDate(decision.decided_at);
  if (decision.granted) {
    return when === '' ? 'On.' : `On since ${when}.`;
  }
  if (when === '') {
    return 'Off. You have not decided about this yet.';
  }
  return `Off since ${when}. Nothing is sorted from here.`;
}

/** Every fixed line on the screen, so a copy sweep can read them all. */
export const CORPUS_CONSENT_COPY_ENTRIES: readonly string[] = [
  CORPUS_CONSENT_TITLE,
  CORPUS_CONSENT_LEAD,
  CORPUS_CONSENT_CONSEQUENCE_HEADING,
  CORPUS_CONSENT_CONSEQUENCE_SENDING,
  CORPUS_CONSENT_CONSEQUENCE_REMOVAL,
  CORPUS_CONSENT_INTIMATE_LINE,
  CORPUS_CONSENT_RECORD_LINE,
  CORPUS_CONSENT_SOURCES_HEADING,
  CORPUS_CONSENT_ROW_LABEL,
  CORPUS_CONSENT_ROW_DESCRIPTION,
  CORPUS_REVOKE_PROMPT,
  CORPUS_REVOKE_CONFIRM_LABEL,
  CORPUS_REVOKE_CANCEL_LABEL,
  CORPUS_NOT_SORTED_YET_NOTE,
  CORPUS_CONSENT_FAILURE,
  ...Object.values(CORPUS_SOURCE_COPY).flatMap((copy) => [copy.label, copy.description]),
];
