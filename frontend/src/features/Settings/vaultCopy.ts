/**
 * Copy for the "Your private vault" Settings surface.
 *
 * A private vault is an optional depth, not a missing piece. Adepthood commits
 * every entry to its own store before a vault is ever contacted, replication is
 * best-effort, and a deployment with no vault at all is fully supported — so
 * every line here describes a vault as something that only ever holds a copy,
 * and none of it frames going without one as a lesser state.
 *
 * The strings are kept in this module rather than inline so the guards in
 * ``__tests__/vaultCopy.test.ts`` can run over the copy itself: no technical,
 * host or routing vocabulary; no loss, risk or obligation framing; and no
 * durability claim the write path does not make.
 *
 * The module is two decks under one set of guards. The promise deck describes a
 * vault to somebody who may never want one; the form deck asks a person for one
 * they already run, and is allowed to spell a transport for exactly as long as
 * a field nobody can fill in would be worse. This surface also owns its own
 * refusal sentences rather than routing them through
 * ``src/api/errorMessages.ts``: the four are swept by the copy guards here, and
 * a second home for them is a second place for them to drift.
 */

/** Hub row label. Names the destination without implying an action is pending. */
export const VAULT_ROW_LABEL = 'Private vault';

/**
 * Hub row description. States the offer and the floor together, so a user who
 * never opens the screen still learns that declining costs them nothing.
 */
export const VAULT_ROW_DESCRIPTION =
  'An optional copy of what you write, in a space you run yourself. Adepthood is complete without one.';

/** Header eyebrow. Sets the register before the title: this is a choice. */
export const VAULT_EYEBROW = 'Optional';

/** Screen and navigation title. Descriptive, not an instruction to connect. */
export const VAULT_TITLE = 'Your private vault';

/**
 * The one promise. It says ownership and choice in a single claim, and the
 * "as you choose" is load-bearing rather than a hedge: an entry marked Public
 * is shareable with the Sangha, so a flat "stays private" would be false for a
 * tier the writer themselves picked. Sovereignty is the promise the app keeps
 * at every setting, with or without a vault.
 */
export const VAULT_PROMISE = 'Your writing is yours, and it stays as private as you choose.';

/**
 * What a vault is. Says "sends a copy of each entry" rather than "a copy of
 * your journal": replication is attempted per entry and a failed one is dropped
 * rather than retried, so whole-journal phrasing would imply a completeness the
 * write path does not keep. The entry is already saved before any of this
 * happens, so it describes an addition and never a transfer.
 */
export const VAULT_WHAT_IT_IS =
  'A private vault is a space you run yourself. When one is connected, Adepthood sends a copy of each entry there as you write — into a place you hold.';

/**
 * The floor. Declining is a complete way to use Adepthood, so this says so
 * plainly and bounds what a vault changes: it adds a copy, and nothing else.
 */
export const VAULT_FLOOR =
  'Adepthood is complete without a vault. Your journal, your reflections, and everything you have written are all here either way. A vault adds a copy in your own space; nothing else changes.';

/**
 * The Intimate boundary. An entry marked Intimate stops before any vault is
 * contacted at all, so this is a statement of shipped behaviour, not intent.
 */
export const VAULT_INTIMATE = 'Entries you mark Intimate are never sent to a vault.';

/**
 * The hinge between the two decks. It opens with the condition rather than the
 * invitation — somebody without a space of their own is told in the first
 * clause that the rest is not addressed to them — and it names leaving before
 * anything is typed, so connecting reads as a reversible thing to try.
 */
export const VAULT_CONNECT_INTRO =
  'If you keep a space of your own, you can connect it here and Adepthood will send a copy of each entry to it. You can disconnect whenever you like, and nothing you have written changes either way.';

/** Form heading with nothing connected. A thing to do, not a step outstanding. */
export const VAULT_ADD_HEADING = 'Connect your vault';

/**
 * Form heading with one already connected. "Replace" rather than "Update",
 * because the write swaps both the address and the key together; there is no
 * way to change one and keep the other.
 */
export const VAULT_REPLACE_HEADING = 'Replace this vault';

/** Address field label. Says whose the vault is, in the register of the deck. */
export const VAULT_ADDRESS_LABEL = 'Your vault address';

/**
 * Address placeholder. One of only two strings allowed to spell a transport:
 * the address has a shape, and a field that will not show it is a field people
 * fill in wrongly and are then refused for.
 */
export const VAULT_ADDRESS_PLACEHOLDER = 'https://your-vault.example';

/** Key field label. Parallel to the address label, so the pair reads as one ask. */
export const VAULT_KEY_LABEL = 'Your vault key';

/**
 * Key placeholder. Points at where the value came from rather than describing
 * its shape: the vault issues it, so the person is being asked to fetch rather
 * than to invent.
 */
export const VAULT_KEY_PLACEHOLDER = 'Paste the key your vault gave you';

/** Reveal toggle, masked state. One word, because it labels a control. */
export const VAULT_KEY_SHOW = 'Show';

/** Reveal toggle, revealed state. The same one word, in the other direction. */
export const VAULT_KEY_HIDE = 'Hide';

/** Submit label. The verb of the deck, so the button restates the offer. */
export const VAULT_CONNECT_BUTTON = 'Connect';

/** Submit label while the request is out. The single ellipsis is deliberate. */
export const VAULT_CONNECTING_BUTTON = 'Connecting…';

/** Leave label. Plain, and never framed as a loss or an undoing. */
export const VAULT_DISCONNECT_BUTTON = 'Disconnect';

/** Leave label while the request is out, matching the connect one exactly. */
export const VAULT_DISCONNECTING_BUTTON = 'Disconnecting…';

/**
 * Label above the connected address. Reads as a fact about the account rather
 * than a badge earned, so the card states where the copies go and stops.
 */
export const VAULT_CONNECTED_LABEL = 'Connected to';

/**
 * The empty state. "Yet" without regret: it reports the state and leaves the
 * offer to the form below rather than reading as something left undone.
 */
export const VAULT_NONE_CONNECTED = 'No vault connected yet.';

/**
 * Said after a successful connect. Describes what changed from here on — new
 * entries — because nothing already written is sent backwards, and a sentence
 * that implied otherwise would promise a backfill there is no path for.
 */
export const VAULT_STATUS_CONNECTED =
  'Connected. Adepthood will send a copy of each new entry to your vault.';

/**
 * Said after a successful disconnect. Answers the only question worth asking
 * at that moment, which is what happened to the writing: nothing.
 */
export const VAULT_STATUS_DISCONNECTED = 'Disconnected. Everything you have written is still here.';

/** Confirmation title. A question, because the action is taken on an answer. */
export const VAULT_DISCONNECT_CONFIRM_TITLE = 'Disconnect this vault?';

/**
 * Confirmation body. Bounds the action in both directions — what stops, what
 * stays, and that coming back is free — so the dialog is not asking anybody to
 * weigh a consequence it left unstated.
 */
export const VAULT_DISCONNECT_CONFIRM_BODY =
  'Adepthood will stop sending copies there. Every entry stays exactly where it is, and you can connect again whenever you like.';

/** The way out of the confirmation. The conventional word, deliberately. */
export const VAULT_CANCEL = 'Cancel';

/**
 * Empty address. Phrased as the next thing to do rather than as a rule broken,
 * which is the register the whole surface is written in.
 */
export const VAULT_ADDRESS_MISSING = 'Add your vault address to connect.';

/** Empty key. The same sentence shape, so the two blanks read as one pair. */
export const VAULT_KEY_MISSING = 'Add your vault key to connect.';

/**
 * The read failed. Blames the moment rather than the person or their vault:
 * the app could not check, which says nothing about whether one is attached.
 */
export const VAULT_LOAD_FAILED = 'Adepthood could not check your vault connection just now.';

/**
 * A connect attempt failed for a reason the screen has no sentence for. Names
 * a moment and invites a retry, because an unrecognised fault is far more
 * often transient than it is something the person can fix by re-reading.
 */
export const VAULT_CONNECT_FAILED =
  'Adepthood could not connect to that vault just now. Try again in a moment.';

/** A disconnect attempt failed. Same shape, same invitation to try again. */
export const VAULT_DISCONNECT_FAILED =
  'Adepthood could not disconnect just now. Try again in a moment.';

/**
 * The address would not parse at all. The remedy is to copy it again rather
 * than to edit it, because nothing in a string this broken is worth salvaging
 * by hand.
 */
export const VAULT_ADDRESS_UNREADABLE =
  'Adepthood cannot read that as an address. Copy it again from your vault.';

/**
 * The address parsed but named nothing. Says which part is missing so somebody
 * looking at their own paste can see the gap rather than re-pasting the same
 * thing and being refused identically.
 */
export const VAULT_ADDRESS_INCOMPLETE = 'That address is missing the part that names your vault.';

/**
 * The address carried more than a vault. Lists the three shapes people
 * actually paste — a sign-in prefix, a query, a fragment — because "forbidden
 * components" is only a useful refusal to whoever wrote the classifier.
 */
export const VAULT_ADDRESS_EXTRA_PARTS =
  'Use the plain address of your vault, with no sign-in, no question mark, and nothing after a #.';

/**
 * The address asked for a transport Adepthood will not carry a key over. The
 * second of the two strings allowed to spell one, and it names the exception
 * rather than a flat rule, so somebody running a vault on their own machine is
 * not left thinking they were refused for good.
 */
export const VAULT_ADDRESS_INSECURE =
  'Adepthood reaches a vault over https:// unless it runs on this machine.';
