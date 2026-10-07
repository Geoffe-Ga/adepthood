/* eslint-env jest */
import { describe, expect, it } from '@jest/globals';

import { CORPUS_CONSENT_ROW_LABEL } from '../corpusConsentCopy';
import * as higherSelfCopy from '../higherSelfCopy';
import * as vaultCopy from '../vaultCopy';

/**
 * Copy guards for the private-vault Settings surface.
 *
 * The deck is now two decks with two different licences. The promise deck still
 * describes a vault to somebody who may never want one, so it may name no host,
 * transport, credential or routing concept at all. The form deck asks a person
 * where their own space lives, and a field that cannot show the shape of an
 * address is a field nobody can fill in — so it is swept by the same technical
 * ban minus the transport alternative, and by nothing looser than that.
 *
 * Both decks are held to the pressure and durability bans without exception:
 * neither may imply entries are at risk, that connecting is required, or that a
 * vault promises anything the write path does not keep.
 */

const {
  HIGHER_SELF_GAIN,
  VAULT_ADDRESS_INSECURE,
  VAULT_ADDRESS_PLACEHOLDER,
  VAULT_ADVANCED_EXPLAINER,
  VAULT_ADVANCED_NOT,
  VAULT_FLOOR,
  VAULT_PROMISE,
  VAULT_ROW_DESCRIPTION,
  VAULT_ROW_LABEL,
  VAULT_SORTING_CHOICE,
} = vaultCopy;

/** The plain name the hub row, the screen and the stack header all share (#3007). */
const PLAIN_NAME = 'Where your writing lives';

/** The deck that describes a vault. Swept by the full technical ban. */
const PROMISE_KEYS = [
  'VAULT_ROW_LABEL',
  'VAULT_ROW_DESCRIPTION',
  'VAULT_EYEBROW',
  'VAULT_TITLE',
  'VAULT_PROMISE',
  'VAULT_WHAT_IT_IS',
  'VAULT_FLOOR',
  'VAULT_INTIMATE',
  'VAULT_CONNECT_INTRO',
  'HIGHER_SELF_GAIN',
  'VAULT_SORTING_CHOICE',
  'VAULT_ADVANCED_TITLE',
  'VAULT_ADVANCED_EXPLAINER',
  'VAULT_ADVANCED_NOT',
  'VAULT_ADVANCED_LEARN_MORE',
  'VAULT_MANAGED_UNKNOWN_BODY',
  'VAULT_MANAGED_UNAVAILABLE_BODY',
] as const;

/** The deck that asks for a vault. Swept by the same ban minus the transport. */
const FORM_KEYS = [
  'VAULT_ADD_HEADING',
  'VAULT_REPLACE_HEADING',
  'VAULT_ADDRESS_LABEL',
  'VAULT_ADDRESS_PLACEHOLDER',
  'VAULT_KEY_LABEL',
  'VAULT_KEY_PLACEHOLDER',
  'VAULT_KEY_SHOW',
  'VAULT_KEY_HIDE',
  'VAULT_CONNECT_BUTTON',
  'VAULT_CONNECTING_BUTTON',
  'VAULT_DISCONNECT_BUTTON',
  'VAULT_DISCONNECTING_BUTTON',
  'VAULT_CONNECTED_LABEL',
  'VAULT_NONE_CONNECTED',
  'VAULT_MANAGED_CONNECTED',
  'VAULT_CONNECTION_UNKNOWN',
  'VAULT_STATUS_CONNECTED',
  'VAULT_STATUS_DISCONNECTED',
  'VAULT_DISCONNECT_CONFIRM_TITLE',
  'VAULT_DISCONNECT_CONFIRM_BODY',
  'VAULT_REPLACE_CONFIRM_TITLE',
  'VAULT_REPLACE_CONFIRM_BODY',
  'VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE',
  'VAULT_REPLACE_UNKNOWN_CONFIRM_BODY',
  'VAULT_REPLACE_BUTTON',
  'VAULT_CANCEL',
  'VAULT_ADDRESS_MISSING',
  'VAULT_KEY_MISSING',
  'VAULT_LOAD_FAILED',
  'VAULT_CONNECT_FAILED',
  'VAULT_DISCONNECT_FAILED',
  'VAULT_ADDRESS_UNREADABLE',
  'VAULT_ADDRESS_INCOMPLETE',
  'VAULT_ADDRESS_EXTRA_PARTS',
  'VAULT_ADDRESS_INSECURE',
  'VAULT_ADDRESS_PRIVATE',
  'VAULT_ADDRESS_NOT_FOUND',
  'VAULT_KEY_REFUSED',
] as const;

const ALL_KEYS = [...PROMISE_KEYS, ...FORM_KEYS];

const PROMISE_COPY = PROMISE_KEYS.map((key) => vaultCopy[key]).join(' ');
const FORM_COPY = FORM_KEYS.map((key) => vaultCopy[key]).join(' ');
const ALL_COPY = `${PROMISE_COPY} ${FORM_COPY}`;

// Hosts, transports, credentials and routing: the vocabulary the promise deck
// is forbidden to expose, because it is describing an idea rather than
// collecting a value.
const BANNED_TECHNICAL =
  /\b(host|hostname|url|uri|endpoint|api key|apikey|bearer|token|credential|mcp|https?|port|protocol|routing|route|server|sync|tenant|node|instance)\b/iu;

// The same ban with the transport alternative removed, and only that one. The
// form has to show somebody the shape of an address they are being asked to
// paste; it still may not name a host, a credential or a routing concept.
const FORM_BANNED_TECHNICAL =
  /\b(host|hostname|url|uri|endpoint|api key|apikey|bearer|token|credential|mcp|port|protocol|routing|route|server|sync|tenant|node|instance)\b/iu;

// Loss and obligation framing: neither deck may imply entries are at risk
// without a vault, nor that connecting one is required of anybody.
const BANNED_PRESSURE =
  /\b(backup|back up|safeguard|protect|secure your|lose|lost|losing|at risk|danger|failure|required|must|need to)\b/iu;

// Durability promises the write path does not make and cannot keep.
const BANNED_DURABILITY =
  /\b(guarantee|guaranteed|never lose|always safe|permanent|permanently stored)\b/iu;

// The only three constants allowed to spell a transport. The third is the
// malformed refusal, which is the one case where the missing piece may sit at
// either end of the address -- so the only sentence true of every instance of
// it has to draw the whole span, and the left edge of that span is the
// transport. Exact, so a fourth bearer fails here rather than drifting in.
const TRANSPORT_BEARERS = [
  'VAULT_ADDRESS_PLACEHOLDER',
  'VAULT_ADDRESS_INSECURE',
  'VAULT_ADDRESS_INCOMPLETE',
];

// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------

describe('vaultCopy — export surface', () => {
  for (const key of ALL_KEYS) {
    it(`${key} is a non-empty string`, () => {
      expect(typeof vaultCopy[key]).toBe('string');
      expect(vaultCopy[key].length).toBeGreaterThan(0);
    });
  }

  it('sorts every export into exactly one of the two guarded decks', () => {
    // Anti-vacuity: an export belonging to neither list is copy nothing below
    // sweeps, and the old single-list guard could go stale without saying so.
    expect([...ALL_KEYS].sort()).toEqual(Object.keys(vaultCopy).sort());
  });

  it('carries every promise constant into the blob the full ban sweeps', () => {
    for (const key of PROMISE_KEYS) {
      expect(PROMISE_COPY).toContain(vaultCopy[key]);
    }
  });

  it('carries every form constant into the blob the narrowed ban sweeps', () => {
    for (const key of FORM_KEYS) {
      expect(FORM_COPY).toContain(vaultCopy[key]);
    }
  });

  it('retires VAULT_SETUP, whose claim the connect form made false', () => {
    expect(Object.keys(vaultCopy)).not.toContain('VAULT_SETUP');
  });
});

// ---------------------------------------------------------------------------
// Verbatim copy deck — these strings are the contract
// ---------------------------------------------------------------------------

describe('vaultCopy — the promise deck, verbatim', () => {
  it('VAULT_ROW_LABEL reads the plain name', () => {
    expect(VAULT_ROW_LABEL).toBe(PLAIN_NAME);
  });

  it('VAULT_ROW_DESCRIPTION names both choices, the separate yes, and the floor', () => {
    expect(VAULT_ROW_DESCRIPTION).toBe(
      'An optional copy of what you write, kept in a vault Adepthood manages or one you run. Saying yes to sorting your writing by Aspect is a separate choice, and the app is complete without either.',
    );
  });

  it('VAULT_EYEBROW reads "Optional"', () => {
    expect(vaultCopy.VAULT_EYEBROW).toBe('Optional');
  });

  it('VAULT_TITLE reads the plain name', () => {
    expect(vaultCopy.VAULT_TITLE).toBe(PLAIN_NAME);
  });

  it('VAULT_PROMISE is the one promise the surface makes', () => {
    expect(VAULT_PROMISE).toBe(
      'Your writing is yours; you choose whether Adepthood sends a copy to a vault.',
    );
  });

  it('VAULT_PROMISE makes the choice about replication without claiming blanket secrecy', () => {
    expect(VAULT_PROMISE).toMatch(/choose whether/iu);
    expect(VAULT_PROMISE).not.toMatch(/private|secret|only you/iu);
  });

  it('VAULT_WHAT_IT_IS describes a vault in plain, non-technical terms', () => {
    expect(vaultCopy.VAULT_WHAT_IT_IS).toBe(
      'A vault holds a copy of what you write, kept for your account alone. You can connect one you run or ask Adepthood to manage one. The people who run a managed vault can read what is in it, and neither kind ever receives Intimate entries.',
    );
  });

  it('VAULT_FLOOR states the app is complete without a vault', () => {
    expect(VAULT_FLOOR).toBe(
      'Adepthood is complete without a vault. Your journal, your reflections, and every entry you have written are all here either way. A vault adds an optional copy of your entries, kept for your account alone; it does not turn sorting on, which stays a separate choice.',
    );
  });

  it('VAULT_INTIMATE names both withdrawal and the offline retry', () => {
    expect(vaultCopy.VAULT_INTIMATE).toBe(
      'An Intimate entry is never sent to your vault. If it was copied there before, Adepthood removes that copy. If your vault is offline, keep Intimate selected and choose it again when the vault is online.',
    );
  });

  it('VAULT_CONNECT_INTRO says connecting is reversible and leaving is free', () => {
    expect(vaultCopy.VAULT_CONNECT_INTRO).toBe(
      'Connecting one is reversible: you can disconnect whenever you like, and nothing you have written changes either way.',
    );
  });

  it('HIGHER_SELF_GAIN is the shared sentence, re-exported word for word', () => {
    expect(HIGHER_SELF_GAIN).toBe(higherSelfCopy.HIGHER_SELF_GAIN);
  });

  it('VAULT_SORTING_CHOICE says a vault is not the yes, and where the yes lives', () => {
    expect(VAULT_SORTING_CHOICE).toBe(
      'Creating a vault does not turn sorting on; that stays a separate choice, under What reflections draw on in Settings.',
    );
    expect(VAULT_SORTING_CHOICE).toContain(CORPUS_CONSENT_ROW_LABEL);
  });

  it('VAULT_ADVANCED_TITLE names the fold as advanced and for a vault you run', () => {
    expect(vaultCopy.VAULT_ADVANCED_TITLE).toBe('Advanced: connect a vault you run yourself');
  });

  it('VAULT_ADVANCED_EXPLAINER says what it is, who it is for, and that nobody needs it', () => {
    expect(VAULT_ADVANCED_EXPLAINER).toBe(
      'This is for people who already run their own vault at a public web address. You give Adepthood that address and the key your vault issued. Adepthood then sends it a copy of each entry when you save or edit it, and of each voice draft if your vault accepts them, and documents you bring in go to it and are kept only there. Nothing Intimate is sent. Nobody needs this to use Adepthood.',
    );
  });

  it('VAULT_ADVANCED_NOT rules out a device folder, a cloud drive and a local address', () => {
    expect(VAULT_ADVANCED_NOT).toBe(
      'It is not a folder on your phone or laptop, and it is not a cloud drive. An address only your own network can reach is refused.',
    );
  });

  it('VAULT_ADVANCED_LEARN_MORE reads "Learn how to run one"', () => {
    expect(vaultCopy.VAULT_ADVANCED_LEARN_MORE).toBe('Learn how to run one');
  });

  it('VAULT_MANAGED_UNKNOWN_BODY points at the Advanced section by name', () => {
    expect(vaultCopy.VAULT_MANAGED_UNKNOWN_BODY).toBe(
      'You can try again later, or connect a vault you run yourself under Advanced, below.',
    );
  });

  it('VAULT_MANAGED_UNAVAILABLE_BODY keeps the floor and points at the Advanced section', () => {
    expect(vaultCopy.VAULT_MANAGED_UNAVAILABLE_BODY).toBe(
      'Creating one is not available for this account yet. Adepthood is complete without it, and you can still connect a vault you run yourself under Advanced, below.',
    );
  });
});

describe('vaultCopy — the form deck, verbatim', () => {
  it('VAULT_ADD_HEADING reads "Connect your vault"', () => {
    expect(vaultCopy.VAULT_ADD_HEADING).toBe('Connect your vault');
  });

  it('VAULT_REPLACE_HEADING reads "Replace this vault"', () => {
    expect(vaultCopy.VAULT_REPLACE_HEADING).toBe('Replace this vault');
  });

  it('VAULT_ADDRESS_LABEL reads "Your vault address"', () => {
    expect(vaultCopy.VAULT_ADDRESS_LABEL).toBe('Your vault address');
  });

  it('VAULT_ADDRESS_PLACEHOLDER shows the shape of an address', () => {
    expect(VAULT_ADDRESS_PLACEHOLDER).toBe('https://your-vault.example');
  });

  it('VAULT_KEY_LABEL reads "Your vault key"', () => {
    expect(vaultCopy.VAULT_KEY_LABEL).toBe('Your vault key');
  });

  it('VAULT_KEY_PLACEHOLDER points at where the key came from', () => {
    expect(vaultCopy.VAULT_KEY_PLACEHOLDER).toBe('Paste the key your vault gave you');
  });

  it('VAULT_KEY_SHOW reads "Show"', () => {
    expect(vaultCopy.VAULT_KEY_SHOW).toBe('Show');
  });

  it('VAULT_KEY_HIDE reads "Hide"', () => {
    expect(vaultCopy.VAULT_KEY_HIDE).toBe('Hide');
  });

  it('VAULT_CONNECT_BUTTON reads "Connect"', () => {
    expect(vaultCopy.VAULT_CONNECT_BUTTON).toBe('Connect');
  });

  it('VAULT_CONNECTING_BUTTON reads "Connecting…"', () => {
    expect(vaultCopy.VAULT_CONNECTING_BUTTON).toBe('Connecting…');
  });

  it('VAULT_DISCONNECT_BUTTON reads "Disconnect"', () => {
    expect(vaultCopy.VAULT_DISCONNECT_BUTTON).toBe('Disconnect');
  });

  it('VAULT_DISCONNECTING_BUTTON reads "Disconnecting…"', () => {
    expect(vaultCopy.VAULT_DISCONNECTING_BUTTON).toBe('Disconnecting…');
  });

  it('VAULT_CONNECTED_LABEL reads "Connected to"', () => {
    expect(vaultCopy.VAULT_CONNECTED_LABEL).toBe('Connected to');
  });

  it('VAULT_NONE_CONNECTED states the empty case without regret', () => {
    expect(vaultCopy.VAULT_NONE_CONNECTED).toBe('No vault connected yet.');
  });

  it('VAULT_STATUS_CONNECTED describes what connecting changed', () => {
    expect(vaultCopy.VAULT_STATUS_CONNECTED).toBe(
      'Connected. Adepthood will send a copy of each new entry to your vault.',
    );
  });

  it('VAULT_STATUS_DISCONNECTED says the writing is still here', () => {
    expect(vaultCopy.VAULT_STATUS_DISCONNECTED).toBe(
      'Disconnected. Everything you have written is still here.',
    );
  });

  it('VAULT_DISCONNECT_CONFIRM_TITLE asks before it acts', () => {
    expect(vaultCopy.VAULT_DISCONNECT_CONFIRM_TITLE).toBe('Disconnect this vault?');
  });

  it('VAULT_DISCONNECT_CONFIRM_BODY bounds what disconnecting does', () => {
    expect(vaultCopy.VAULT_DISCONNECT_CONFIRM_BODY).toBe(
      'Adepthood will stop sending copies there. Every entry stays exactly where it is, and you can connect again whenever you like.',
    );
  });

  it('VAULT_CANCEL reads "Cancel"', () => {
    expect(vaultCopy.VAULT_CANCEL).toBe('Cancel');
  });

  it('VAULT_ADDRESS_MISSING asks for the address rather than scolding', () => {
    expect(vaultCopy.VAULT_ADDRESS_MISSING).toBe('Add your vault address to connect.');
  });

  it('VAULT_KEY_MISSING asks for the key rather than scolding', () => {
    expect(vaultCopy.VAULT_KEY_MISSING).toBe('Add your vault key to connect.');
  });

  it('VAULT_LOAD_FAILED blames the moment, not the person', () => {
    expect(vaultCopy.VAULT_LOAD_FAILED).toBe(
      'Adepthood could not check your vault connection just now.',
    );
  });

  it('VAULT_CONNECT_FAILED invites a retry', () => {
    expect(vaultCopy.VAULT_CONNECT_FAILED).toBe(
      'Adepthood could not connect to that vault just now. Try again in a moment.',
    );
  });

  it('VAULT_DISCONNECT_FAILED invites a retry', () => {
    expect(vaultCopy.VAULT_DISCONNECT_FAILED).toBe(
      'Adepthood could not disconnect just now. Try again in a moment.',
    );
  });

  it('VAULT_ADDRESS_UNREADABLE covers an address nothing can parse', () => {
    expect(vaultCopy.VAULT_ADDRESS_UNREADABLE).toBe(
      'Adepthood cannot read that as an address. Copy it again from your vault.',
    );
  });

  it('VAULT_ADDRESS_INCOMPLETE draws the whole span an address has to cover', () => {
    expect(vaultCopy.VAULT_ADDRESS_INCOMPLETE).toBe(
      'Use the whole address, from https:// through the name of your vault.',
    );
  });

  it('VAULT_ADDRESS_EXTRA_PARTS covers an address carrying more than a vault', () => {
    expect(vaultCopy.VAULT_ADDRESS_EXTRA_PARTS).toBe(
      'Use the plain address of your vault, with no sign-in, no question mark, and nothing after a #.',
    );
  });

  it('VAULT_ADDRESS_INSECURE asks for https and rules out this machine', () => {
    expect(VAULT_ADDRESS_INSECURE).toBe(
      'Adepthood reaches a vault over https://, and cannot reach one that runs on this machine.',
    );
  });

  it('VAULT_ADDRESS_PRIVATE covers a vault only the local network can reach', () => {
    expect(vaultCopy.VAULT_ADDRESS_PRIVATE).toBe(
      'That address points somewhere only your own network can reach. Connect a vault Adepthood can reach from the open internet.',
    );
  });

  it('VAULT_ADDRESS_NOT_FOUND covers an address that pointed nowhere', () => {
    expect(vaultCopy.VAULT_ADDRESS_NOT_FOUND).toBe(
      'Adepthood could not work out where that address points. Check it against your vault, and try again in a moment.',
    );
  });

  it('VAULT_KEY_REFUSED names the paste rather than quoting the key', () => {
    expect(vaultCopy.VAULT_KEY_REFUSED).toBe(
      'That key has a space or a character Adepthood cannot send. Copy it again from your vault.',
    );
  });

  it('VAULT_CONNECTION_UNKNOWN reports the unread state and points at the folded form', () => {
    expect(vaultCopy.VAULT_CONNECTION_UNKNOWN).toBe(
      'Adepthood could not tell whether a vault is already connected. You can still connect one you run yourself under Advanced, below, and Adepthood will ask first.',
    );
  });

  it('VAULT_REPLACE_CONFIRM_TITLE asks before it replaces', () => {
    expect(vaultCopy.VAULT_REPLACE_CONFIRM_TITLE).toBe('Replace this vault?');
  });

  it('VAULT_REPLACE_CONFIRM_BODY bounds what replacing does to the old vault', () => {
    expect(vaultCopy.VAULT_REPLACE_CONFIRM_BODY).toBe(
      'Adepthood will send copies to the new vault instead. Everything in the vault you are connected to now stays exactly where it is, and nothing you have written changes.',
    );
  });

  it('VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE asks without claiming to know', () => {
    expect(vaultCopy.VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE).toBe('Connect this vault?');
  });

  it('VAULT_REPLACE_UNKNOWN_CONFIRM_BODY names the uncertainty and its consequence', () => {
    expect(vaultCopy.VAULT_REPLACE_UNKNOWN_CONFIRM_BODY).toBe(
      'Adepthood could not tell whether another vault is already connected. If one is, this replaces it, and everything in it stays exactly where it is.',
    );
  });

  it('VAULT_REPLACE_BUTTON reads "Replace"', () => {
    expect(vaultCopy.VAULT_REPLACE_BUTTON).toBe('Replace');
  });
});

// ---------------------------------------------------------------------------
// Negative guards
// ---------------------------------------------------------------------------

describe('vaultCopy — banned technical vocabulary', () => {
  it('the promise deck names no host, transport, credential, or routing concept', () => {
    expect(PROMISE_COPY).not.toMatch(BANNED_TECHNICAL);
  });

  it('the form deck names no host, credential, or routing concept either', () => {
    expect(FORM_COPY).not.toMatch(FORM_BANNED_TECHNICAL);
  });
});

describe('vaultCopy — the transport is spelled three times and nowhere else', () => {
  it('only the placeholder and the two shape refusals say https', () => {
    const bearers = ALL_KEYS.filter((key) => /https/iu.test(vaultCopy[key]));

    expect([...bearers].sort()).toEqual([...TRANSPORT_BEARERS].sort());
  });

  it('the three that do say it are the ones the form cannot work without', () => {
    expect(VAULT_ADDRESS_PLACEHOLDER).toMatch(/https/u);
    expect(VAULT_ADDRESS_INSECURE).toMatch(/https/u);
    expect(vaultCopy.VAULT_ADDRESS_INCOMPLETE).toMatch(/https/u);
  });
});

describe('vaultCopy — no copy survives the destination guard being wrong about it', () => {
  it('never says a vault is reachable when it runs on this machine', () => {
    // The clause is now false: a vault on the user's own machine is refused
    // outright, so copy implying otherwise sends somebody chasing a connection
    // that cannot exist.
    expect(ALL_COPY).not.toMatch(/unless it runs on this machine/iu);
  });
});

describe('vaultCopy — no risk or obligation framing', () => {
  it('never implies entries are at risk, nor that a vault is required', () => {
    expect(ALL_COPY).not.toMatch(BANNED_PRESSURE);
  });
});

describe('vaultCopy — no durability claim', () => {
  it('makes no promise the write path cannot keep', () => {
    expect(ALL_COPY).not.toMatch(BANNED_DURABILITY);
  });
});

describe('vaultCopy — straight apostrophes only', () => {
  it('carries no curly quote anywhere in either deck', () => {
    // Smart quotes break the TypeScript lexer when a specialist pastes them as
    // delimiters, and they read as a different character to a copy diff.
    expect(ALL_COPY).not.toMatch(/[‘’“”]/u);
  });
});

// ---------------------------------------------------------------------------
// Positive guards
// ---------------------------------------------------------------------------

describe('vaultCopy — the floor is stated outright', () => {
  it('VAULT_FLOOR asserts completeness without a vault', () => {
    expect(VAULT_FLOOR).toMatch(/complete without/iu);
  });

  it('VAULT_FLOOR bounds what a vault changes without claiming nothing else does', () => {
    // "Nothing else changes" was false: a vault you run that can answer
    // reflections may answer them, and documents you bring in go to it.
    expect(VAULT_FLOOR).toMatch(/does not turn sorting on/u);
    expect(VAULT_FLOOR).not.toMatch(/nothing else changes/iu);
  });

  it('VAULT_FLOOR promises only what stays here: entries, not documents a vault keeps', () => {
    // With a vault connected, a document brought in is kept only in the vault,
    // so "everything you have written is here either way" would be untrue.
    expect(VAULT_FLOOR).toMatch(/every entry you have written are all here either way/u);
    expect(VAULT_FLOOR).toMatch(/copy of your entries/u);
    expect(VAULT_FLOOR).not.toMatch(/everything you have written/u);
  });
});

describe('vaultCopy — a plain name, with Creek left to the custody statements (#3007)', () => {
  const NAMED = [
    'VAULT_ROW_LABEL',
    'VAULT_TITLE',
    'VAULT_ROW_DESCRIPTION',
    'VAULT_ADVANCED_TITLE',
    'VAULT_ADVANCED_EXPLAINER',
    'VAULT_ADVANCED_NOT',
    'VAULT_ADVANCED_LEARN_MORE',
  ] as const;

  for (const key of NAMED) {
    it(`${key} does not say Creek`, () => {
      expect(vaultCopy[key]).not.toMatch(/creek/iu);
    });
  }

  it('the row description names both choices, the optionality and the floor', () => {
    expect(VAULT_ROW_DESCRIPTION).toMatch(/^An optional copy/u);
    expect(VAULT_ROW_DESCRIPTION).toMatch(/Adepthood manages/u);
    expect(VAULT_ROW_DESCRIPTION).toMatch(/one you run/u);
    expect(VAULT_ROW_DESCRIPTION).toMatch(/complete without either/u);
  });
});

describe('vaultCopy — the Advanced fold explains itself (#3007)', () => {
  it('says who it is for and what it takes', () => {
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/already run their own vault/u);
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/public web address/u);
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/the key your vault issued/u);
  });

  it('says everything Adepthood then sends, and that nobody needs it', () => {
    // Entries are re-sent on every edit, voice drafts are mirrored to a vault
    // that accepts them, and a document brought in goes to the vault instead of
    // the corpus -- so it is kept only there. All three withhold Intimate.
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/a copy of each entry when you save or edit it/u);
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/each voice draft if your vault accepts them/u);
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(
      /documents you bring in go to it and are kept only there/u,
    );
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/Nothing Intimate is sent\./u);
    expect(VAULT_ADVANCED_EXPLAINER).not.toMatch(/each new entry/u);
    expect(VAULT_ADVANCED_EXPLAINER).toMatch(/Nobody needs this/u);
  });

  it('says what it is not', () => {
    expect(VAULT_ADVANCED_NOT).toMatch(/phone or laptop/u);
    expect(VAULT_ADVANCED_NOT).toMatch(/cloud drive/u);
    expect(VAULT_ADVANCED_NOT).toMatch(/only your own network can reach is refused/u);
  });

  it('every line pointing at the folded form names the Advanced section', () => {
    for (const key of [
      'VAULT_MANAGED_UNKNOWN_BODY',
      'VAULT_MANAGED_UNAVAILABLE_BODY',
      'VAULT_CONNECTION_UNKNOWN',
    ] as const) {
      expect(vaultCopy[key]).toMatch(/under Advanced, below/u);
    }
  });
});

describe('vaultCopy — a vault is not the yes to sorting (#3003)', () => {
  it('every line that speaks of reflections points at the sorting decision', () => {
    // Connecting or creating a vault turns no sorting on, so no line here may
    // let a vault stand in for that decision. A line that mentions reflections
    // must either be the yes itself or say a vault is not it.
    const speaking = ALL_KEYS.filter((key) => /reflection/iu.test(vaultCopy[key]));

    expect(speaking.length).toBeGreaterThan(0);
    for (const key of speaking) {
      expect(vaultCopy[key]).toMatch(/say yes to sorting|does not turn sorting on/iu);
    }
  });

  it('the row description gives the gain only as the separate yes', () => {
    expect(VAULT_ROW_DESCRIPTION).toMatch(/Saying yes to sorting .* is a separate choice/u);
  });

  it('names none of the plumbing the reader never needs to learn', () => {
    expect(ALL_COPY).not.toMatch(/system prompt|retrieval|fragment|ontolog|corpus store/iu);
  });
});

describe('vaultCopy — exactly one promise', () => {
  it('VAULT_PROMISE contains exactly one full stop', () => {
    expect(VAULT_PROMISE.split('.').length - 1).toBe(1);
  });

  it('the full stop in VAULT_PROMISE is its final character', () => {
    expect(VAULT_PROMISE.endsWith('.')).toBe(true);
  });
});
