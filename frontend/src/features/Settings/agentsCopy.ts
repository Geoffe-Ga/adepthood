/**
 * Copy for "Agents that may read your vault", the section under "Where your
 * writing lives" that lists every agent a person approved and lets them stop
 * one (#3534).
 *
 * An agent is an optional depth on top of an optional depth: somebody who runs
 * a program elsewhere -- an assistant on their own computer, a chat service's
 * connector -- may let it draft and reflect from the writing in their vault.
 * Nobody needs to, so every line here says what an agent may do, that Intimate
 * entries stay out of reach, and that stopping one is always one press away,
 * and none of it frames going without one as a lesser state.
 *
 * The strings live in this module, not inline, so the guards in
 * ``__tests__/agentsCopy.test.ts`` sweep the copy itself the way
 * ``vaultCopy.test.ts`` sweeps that deck: no "Creek" in a heading (#3007), no
 * transport, protocol or authorization vocabulary in the body, and no loss or
 * obligation framing. The one technical value the section shows -- the address
 * to paste into an agent -- is data the server hands back, not copy, and is
 * rendered beside these strings rather than inside them.
 *
 * ``AGENT_GRANT_PHRASES`` is the same plain-words mapping the consent page uses
 * (``backend/src/services/oauth_consent_copy.py`` ``GRANT_DESCRIPTIONS``), word
 * for word. ``__tests__/agentGrantDrift.test.ts`` reads the Python and fails the
 * day the two disagree, so a person reads one sentence for one permission on
 * both surfaces.
 */

/** Above the heading, as on the vault screen's own header. */
export const AGENTS_EYEBROW = 'Optional';

/** The section's heading. */
export const AGENTS_HEADING = 'Agents that may read your vault';

/**
 * What an agent is, what is kept from it, and the floor. One paragraph.
 *
 * The middle sentence is the consent page's own floor, word for word
 * (``CONSENT_FLOOR``), rather than a sentence about what an agent "sees": the
 * custody guard (``backend/tests/test_custody_decision_record.py``) reads any
 * flat "never sees" as a custody promise, and the honest statement is about
 * what the vault hands over, which is what this one says.
 */
export const AGENTS_WHAT_THEY_ARE =
  'An agent you run elsewhere can draft and reflect from the Open and Personal writing in your vault. Intimate entries are never included. You can stop any of them here. Adepthood is complete without this.';

/** Above the address a person pastes into an agent. */
export const AGENTS_ADDRESS_LABEL = 'Where an agent finds your vault';

/** Under the address: what to do with it, and what happens next. */
export const AGENTS_ADDRESS_NOTE =
  'Give this address to the agent you run. It will ask you to approve it here before it can read anything.';

/** A managed allocation whose public agent address could not be confirmed (#3545). */
export const AGENTS_MANAGED_ADDRESS_UNAVAILABLE =
  'Adepthood can’t show an agent sign-in address for this vault yet.';

/** The copy affordance beside the address. */
export const AGENTS_ADDRESS_COPY = 'Copy address';

/** Said once the address is on the clipboard. */
export const AGENTS_ADDRESS_COPIED = 'Copied.';

/** Said when this device would not take it, with the way that always works. */
export const AGENTS_ADDRESS_COPY_FAILED =
  'Adepthood could not copy it here. Press and hold the address to copy it yourself.';

/**
 * Nobody approved yet. Names the one way an agent arrives, and offers no
 * button: there is nothing on this screen that could add one.
 */
export const AGENTS_EMPTY =
  "No agent can read your vault yet. Approve one from the agent's own sign-in flow and it will show here.";

/** The list could not be read. Never says "none" over a read that did not land. */
export const AGENTS_LOAD_FAILED =
  'Adepthood could not check which agents can read your vault just now.';

/** Stands in for an agent that gave no name, in the consent page's own words. */
export const AGENTS_UNNAMED = 'An agent that did not give its name';

/** Where an agent signed in from, when that is the person's own computer. */
export const AGENTS_ON_THIS_COMPUTER = 'Runs on your own computer';

/** Precedes the site a hosted agent signs a person in through. */
export const AGENTS_SIGNS_IN_THROUGH = 'Signs in through';

/** An agent approved and not yet used. */
export const AGENTS_NOT_USED_YET = 'Not used yet';

/** Precedes how long ago an agent last signed in. */
export const AGENTS_LAST_USED = 'Last used';

/** The press that starts stopping one agent. */
export const AGENTS_STOP = 'Stop';

/** The question asked in the row, in place, before anything is sent. */
export const AGENTS_STOP_CONFIRM =
  'Stop this agent? It can no longer reach your vault within ten minutes. You can approve it again from the agent whenever you like.';

/** The answer that goes ahead. */
export const AGENTS_STOP_CONFIRM_BUTTON = 'Stop it';

/** The answer that changes nothing. */
export const AGENTS_STOP_KEEP = 'Keep';

/** While the stop is on its way. */
export const AGENTS_STOPPING = 'Stopping…';

/** Once the server has said yes. */
export const AGENTS_STOPPED =
  'Stopped. That agent can no longer reach your vault within ten minutes.';

/** When the stop did not land. The agent is still listed, because it still can. */
export const AGENTS_STOP_FAILED =
  'Adepthood could not stop that agent just now. It is still listed; try again in a moment.';

/** Above the list of what agents asked the vault for (#3535). */
export const ACTIVITY_HEADING = 'Recent activity';

/**
 * The one line under that heading. It is about what the list can show -- the
 * request, not the result -- rather than a promise about what an agent "sees",
 * which the custody guard reads as a custody claim.
 */
export const ACTIVITY_WHAT_IT_IS = 'What each agent asked for, never what it read.';

/** Nothing asked yet. */
export const ACTIVITY_EMPTY =
  'Nothing yet. When an agent asks your vault for something, it shows here.';

/** The vault could not be read. Never says "nothing yet" over a read that did not land. */
export const ACTIVITY_UNAVAILABLE =
  'Adepthood could not check your vault for recent activity just now.';

/** The small marker beside a call the vault turned down before it ran. */
export const ACTIVITY_REFUSED = 'Refused';

/**
 * What each permission lets an agent do, keyed by the name the server sends.
 *
 * The consent page's mapping, word for word (see the module note). A name not
 * in here renders as nothing rather than as itself, so ``vault:desk`` never
 * reaches a person.
 */
export const AGENT_GRANT_PHRASES: ReadonlyMap<string, string> = new Map([
  ['vault:read', 'Read and search your Open and Personal writing'],
  ['vault:desk', 'Draft and reflect from your Open and Personal writing'],
  ['vault:journal', 'Add journal entries'],
  ['vault:pipeline', 'Re-sort your vault'],
  ['offline_access', 'Stay connected without asking you again'],
]);
