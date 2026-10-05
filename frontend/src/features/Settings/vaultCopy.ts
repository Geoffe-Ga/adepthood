/**
 * Copy for the "Where your corpus lives" Settings surface.
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
 * The module is two decks under one set of guards. The promise deck distinguishes
 * a vault somebody runs from one Adepthood manages, and explains the folded
 * Advanced section that asks for one; the form deck asks a person for one they
 * already run, and three of its strings are allowed to spell a transport for
 * exactly as long as a field nobody can fill in would be worse.
 *
 * Labels, titles and descriptions use the plain name and never "Creek" (#3007);
 * "Creek" stays only in the custody statements that name who can read a managed
 * vault, because dropping it there would loosen a disclosure.
 *
 * A vault is not the yes to sorting (#3003). The re-exported
 * ``HIGHER_SELF_GAIN`` says what that yes gives, and every line here that speaks
 * of reflections points at that separate decision rather than at a vault.
 * This surface also owns its own
 * refusal sentences rather than routing them through
 * ``src/api/errorMessages.ts``: all seven are swept by the copy guards here,
 * and a second home for them is a second place for them to drift.
 */

export { HIGHER_SELF_GAIN } from './higherSelfCopy';

/**
 * Hub row label, and the screen's name everywhere it is shown. Plain words for
 * the place, without the product name of the software a vault runs (#3007).
 */
export const VAULT_ROW_LABEL = 'Where your corpus lives';

/**
 * Hub row description. States the offer, both ways to take it, and the floor
 * together, so a user who never opens the screen still learns that declining
 * costs them nothing. The gain is named only as the separate yes to sorting,
 * because a vault turns no sorting on.
 */
export const VAULT_ROW_DESCRIPTION =
  'An optional copy of what you write, kept in a vault Adepthood manages or one you run. Saying yes to sorting your writing by Aspect is a separate choice, and the app is complete without either.';

/** Header eyebrow. Sets the register before the title: this is a choice. */
export const VAULT_EYEBROW = 'Optional';

/**
 * Screen and navigation title. Descriptive, not an instruction to connect. The
 * stack header paints it, so the screen body does not (#2962).
 */
export const VAULT_TITLE = 'Where your corpus lives';

/**
 * The one promise. It says ownership and makes the choice specifically about
 * replication, without implying operator blindness or blanket secrecy that
 * neither Adepthood nor a provider-managed vault can promise.
 */
export const VAULT_PROMISE =
  'Your writing is yours; you choose whether Adepthood sends a copy to a vault.';

/**
 * What a vault is. Says "sends a copy of each entry" rather than "a copy of
 * your journal": replication is attempted per entry and a failed one is dropped
 * rather than retried, so whole-journal phrasing would imply a completeness the
 * write path does not keep. The entry is already saved before any of this
 * happens, so it describes an addition and never a transfer.
 */
export const VAULT_WHAT_IT_IS =
  'A vault holds an account-scoped copy of what you write. You can connect one you run or ask Adepthood to manage one. A managed vault is readable by privileged operators, and neither kind receives Intimate entries.';

/**
 * The floor. Declining is a complete way to use Adepthood, so this says so
 * plainly and bounds what a vault changes: it adds a copy and turns no sorting
 * on. It no longer says "nothing else changes", which was not true: a vault you
 * run that can answer reflections may answer them, and documents you bring in
 * have somewhere to go -- a document goes to a vault or nowhere (#3015, #3016).
 * For the same reason it promises entries rather than "everything you have
 * written": a document brought in is kept only in the vault. "Complete without
 * a vault" stays true of the journal and reflections, which are what it names.
 */
export const VAULT_FLOOR =
  'Adepthood is complete without a vault. Your journal, your reflections, and every entry you have written are all here either way. A vault adds an optional account-scoped copy of your entries; it does not turn sorting on, which stays a separate choice.';

/**
 * Said where somebody is about to create a managed vault, so that the press
 * is not mistaken for the yes to sorting. It names where that yes lives.
 */
export const VAULT_SORTING_CHOICE =
  'Creating a vault does not turn sorting on; that stays a separate choice, under What reflections draw on in Settings.';

/**
 * The Intimate boundary. No Intimate body is sent. A prior non-Intimate copy is
 * withdrawn by identity, and an unavailable vault leaves the stricter local
 * choice in place with an explicit retry rather than claiming it was removed.
 */
export const VAULT_INTIMATE =
  'An Intimate entry is never sent to your vault. If it was copied there before, Adepthood removes that copy. If your vault is offline, keep Intimate selected and choose it again when the vault is online.';

/**
 * The hinge between the explanation and the form, inside the Advanced fold. The
 * explanation above it has already said who this is for and what it sends, so
 * this names leaving before anything is typed, and connecting reads as a
 * reversible thing to try.
 */
export const VAULT_CONNECT_INTRO =
  'Connecting one is reversible: you can disconnect whenever you like, and nothing you have written changes either way.';

/**
 * The header of the fold the form lives behind. Says the section is advanced and
 * who it is for before anybody opens it, so somebody without a vault of their
 * own can pass it by.
 */
export const VAULT_ADVANCED_TITLE = 'Advanced: connect a vault you run yourself';

/**
 * What the fold is, who it is for, and everything Adepthood sends once it is
 * filled in: an entry each time it is saved or edited, a voice draft when the
 * vault advertises that it stores them, and any document brought in -- which
 * is kept only there, because a document has no other destination (#3016). The
 * write, voice-draft and upload paths all withhold Intimate material before the
 * vault is contacted, so "Nothing Intimate is sent" holds for all three. It ends
 * on the floor.
 */
export const VAULT_ADVANCED_EXPLAINER =
  'This is for people who already run their own vault at a public web address. You give Adepthood that address and the key your vault issued. Adepthood then sends it a copy of each entry when you save or edit it, and of each voice draft if your vault accepts them, and documents you bring in go to it and are kept only there. Nothing Intimate is sent. Nobody needs this to use Adepthood.';

/**
 * What it is not. The two things people most often take a vault to be, and the
 * address the server refuses, so nobody goes looking for a setting that cannot
 * work.
 */
export const VAULT_ADVANCED_NOT =
  'It is not a folder on your phone or laptop, and it is not a cloud drive. An address only your own network can reach is refused.';

/** The link to the plain-language guide in ``docs/your-data.md``. */
export const VAULT_ADVANCED_LEARN_MORE = 'Learn how to run one';

/**
 * Managed availability could not be checked. Points at the folded form by the
 * name its header shows, because "below" alone would name a form nobody sees.
 */
export const VAULT_MANAGED_UNKNOWN_BODY =
  'You can try again later, or connect a vault you run yourself under Advanced, below.';

/** Managed vaults are not open to this account yet. Keeps the floor, names the fold. */
export const VAULT_MANAGED_UNAVAILABLE_BODY =
  'Creating one is not available for this account yet. Adepthood is complete without it, and you can still connect a vault you run yourself under Advanced, below.';

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
 * Address placeholder. One of only three strings allowed to spell a transport:
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
 * offers below it rather than reading as something left undone.
 */
export const VAULT_NONE_CONNECTED = 'No vault connected yet.';

/** A confirmed managed binding says nothing about current runtime health. */
export const VAULT_MANAGED_CONNECTED =
  'A managed vault is connected to your account. This does not check whether it is reachable right now.';

/**
 * Said when the read could not establish whether a vault is attached at all.
 * "No vault connected yet" would be an answer nobody gave, and for somebody who
 * does have one it would be a false report of losing it, so this states the gap
 * instead. The second clause is not reassurance but a promise the confirmation
 * gate keeps: a connect made from this state asks before it sends. It names the
 * Advanced section, because in this state the form is folded away.
 */
export const VAULT_CONNECTION_UNKNOWN =
  'Adepthood could not tell whether a vault is already connected. You can still connect one you run yourself under Advanced, below, and Adepthood will ask first.';

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

/** Confirmation title for a connect that would replace one already attached. */
export const VAULT_REPLACE_CONFIRM_TITLE = 'Replace this vault?';

/**
 * Confirmation body. Bounds the swap in both directions — where copies go from
 * here, and what happens to the vault being left — because the fear worth
 * answering at that moment is that replacing empties the old space. It does
 * not: Adepthood only ever stops writing to it.
 */
export const VAULT_REPLACE_CONFIRM_BODY =
  'Adepthood will send copies to the new vault instead. Everything in the vault you are connected to now stays exactly where it is, and nothing you have written changes.';

/**
 * Confirmation title when the read could not say whether anything is attached.
 * It asks about the vault in hand rather than about one it cannot see: claiming
 * there is another to replace would invent the same answer the notice above it
 * declines to invent.
 */
export const VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE = 'Connect this vault?';

/**
 * Confirmation body for that case. The uncertainty comes first and its
 * consequence second, so the decision is made on what is actually known, and
 * the closing clause is the same promise the certain version makes about the
 * same thing — a vault that is replaced keeps everything in it.
 */
export const VAULT_REPLACE_UNKNOWN_CONFIRM_BODY =
  'Adepthood could not tell whether another vault is already connected. If one is, this replaces it, and everything in it stays exactly where it is.';

/**
 * The affirmative in both replace confirmations. It names the act rather than
 * agreeing ("OK"), and it says "Replace" even in the dialog that could not
 * establish there is anything to replace, because that is the outcome the
 * person is accepting the risk of.
 */
export const VAULT_REPLACE_BUTTON = 'Replace';

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
 * The address parsed but did not name a vault. One classifier defect covers
 * three different gaps — ``vault.example.com`` and ``//vault.example.com`` are
 * missing the transport, ``https://`` is missing the name — and the server
 * withholds which on purpose, so no sentence here can name the missing part
 * without being wrong about the other two. It was named anyway, and it was
 * named wrongly for the commonest paste of all: a bare vault name, told it was
 * missing its own name. So this draws the whole span an address has to cover
 * and states the fix rather than the defect.
 */
export const VAULT_ADDRESS_INCOMPLETE =
  'Use the whole address, from https:// through the name of your vault.';

/**
 * The address carried more than a vault. Lists the three shapes people
 * actually paste — a sign-in prefix, a query, a fragment — because "forbidden
 * components" is only a useful refusal to whoever wrote the classifier.
 */
export const VAULT_ADDRESS_EXTRA_PARTS =
  'Use the plain address of your vault, with no sign-in, no question mark, and nothing after a #.';

/**
 * The address asked for a transport Adepthood will not carry a key over. One
 * of the strings allowed to spell a transport, and it states the whole rule
 * rather than an exception to it: the exception it used to name is now false,
 * because a vault on the reader's own machine is refused outright by the
 * destination guard. Copy implying otherwise sends somebody chasing a
 * connection that cannot be made.
 */
export const VAULT_ADDRESS_INSECURE =
  'Adepthood reaches a vault over https://, and cannot reach one that runs on this machine.';

/**
 * The address named a destination only the reader's own network can reach.
 * Says where the address points and what would be reachable instead, rather
 * than repeating the classifier's ``detail``: that phrase is withheld from the
 * refusal body on purpose, being written for whoever reads the server's logs.
 */
export const VAULT_ADDRESS_PRIVATE =
  'That address points somewhere only your own network can reach. Connect a vault Adepthood can reach from the open internet.';

/**
 * Nothing could be found at that address. It invites a re-check and a retry
 * together because the server cannot tell a name that does not exist from a
 * resolver it could not reach, and refuses both identically — so a sentence
 * offering only one of the two remedies would be the wrong advice half the
 * time, and neither half is the reader's fault.
 */
export const VAULT_ADDRESS_NOT_FOUND =
  'Adepthood could not work out where that address points. Check it against your vault, and try again in a moment.';

/**
 * The key could not be carried. Names the shape of the problem — a stray space,
 * or a character that cannot travel — and quotes nothing, because on this one
 * field the rejected value is the secret. The remedy is to copy it again rather
 * than to edit it: a key that arrived with a hole in it is not worth patching
 * by hand.
 */
export const VAULT_KEY_REFUSED =
  'That key has a space or a character Adepthood cannot send. Copy it again from your vault.';
