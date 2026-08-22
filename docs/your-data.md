# Your data

Adepthood is journal-first, and the writing is yours. This page says exactly
what that means in practice: how to take a copy of everything you have written,
how to delete your account, what deletion reaches, and what deliberately
survives it.

It is written for the person using the app, not only for the person building
it. Nothing here is a promise the code does not keep — every claim below is
pinned by a test (`backend/tests/test_account_deletion_policy.py`,
`backend/tests/test_data_export_manifest.py`), and the authoritative statement
of each half lives in `backend/src/domain/account_deletion.py` and
`backend/src/domain/data_export.py`.

## Taking a copy of your writing

**Settings → Export my data.** Nothing to request, nothing to wait for, no
email with a link in it: the app asks the server for your archive, saves it to
this device, and hands it to the share sheet so you can put it wherever you
keep things.

You get two files.

- **`adepthood-export-<date>.json`** — everything, in a format that can be read
  back in. Your entries, their titles, tags and privacy tiers; your habits,
  goals, groups and every check-in; your practices, sessions, recipes and tags;
  your course progress, prompt answers and reflections; your margin notes and
  promoted passages; your energy plans and return arcs; the depths you chose;
  and the ontologized corpus — your own sentences, classified into the ten
  frequencies.
- **`adepthood-journal-<date>.md`** — the journal alone, as Markdown, oldest
  first. This is the one to open if you want to *read* it. Entries you deleted
  are not in it.

Your entries are stored encrypted, and the export decrypts them. What you get
is what you wrote, not what the database holds. Anyone who gets hold of the
file can read it, which is the point and also the caution: it is a plaintext
copy of your journal, so put it somewhere you would be willing to keep a
paper one.

### What the export leaves out, and why

Three kinds of thing, and the archive itself lists them under `not_included`
with the reason for each, so the file can be trusted about what it does contain.

1. **Secrets.** Your password hash, your sign-in links to Google or Apple, any
   outstanding password-reset token, and the key to a Creek Vault you
   connected. A working credential in a file on a laptop is a credential
   somebody else can use.
2. **Records the system kept about your usage rather than things you wrote.**
   Sign-in attempts and the addresses they came from, AI metering, wallet
   accounting, which tips the interface has shown you.
3. **Things that are not yours to take.** The shared 36-week curriculum, and
   purchase records held by the seller. Practices you *contributed* to the
   shared catalogue are yours and are in the export — you wrote them.

### If you use a Creek Vault

The export covers your Adepthood data. Your vault holds its own copy and
exports from its own side; nothing here reaches into it.

### That an export happened is recorded

The server notes the date, your account id, and how many records went — and
nothing else. Not a line of what the archive said. The same rule as the
deletion receipt, for the same reason.

## Deleting your account

**Settings → Delete account.** You retype the email address you sign in with,
and the account is erased.

It is **immediate and irreversible**. There is no grace period, no
deactivation, and no support path to get any of it back. If you want a copy of
your writing, [take it first](#taking-a-copy-of-your-writing).

Your session dies with the account: the token on your device stops working on
the next request, on every device.

### What is deleted

Everything in the app that is yours:

- Every journal entry, including anything marked Intimate, and the margin
  notes, promoted passages and reflections attached to them.
- Habits, goals, goal groups, check-ins and streaks.
- Practices you assigned yourself, sessions you logged, recipes and tags you
  made.
- Course progress, chapter completions and prompt answers.
- Energy plans, return arcs, invitation history, depth preferences and
  interface state.
- Your account row itself — email, password hash, display name, wallet
  balances — and every linked Google or Apple sign-in.
- The record of sign-in attempts made with your address, including the IP
  addresses on them.

### What survives, and why

Three things, each for a stated reason:

1. **Practices you contributed to the shared catalogue.** Other people may
   already have them assigned, so the entry stays and stops naming you. The
   same applies to share links you minted: recipients may already hold the URL.
2. **Purchase receipts.** The row stays, and so does the email address on it.
   This is the one identifier that deliberately outlives a deletion. It has to:
   the address is how a licence or token pack you paid for is matched back to
   you, so erasing it would quietly confiscate something you bought if you ever
   came back. Retaining a payment record is also the ordinary GDPR Art. 17(3)
   exemption. Nothing in the row points at an account any more.
3. **A note that a deletion happened.** Date, an internal id that now names
   nobody, and per-table counts of how many rows went. No content, no address.

The wallet ledger for your own account goes with the account. Ledger rows
recording something you did to *another* account's wallet stay, with you
cleared off them.

### If you use a Creek Vault

Deleting your Adepthood account **does not purge your vault**, and cannot.
Creek's published capability set has no purge verb, so nothing Adepthood does
reaches inside your enclave — which is the point of an enclave.

Run `creek purge` against your own vault to erase the copy it holds. The
deletion confirmation screen repeats this if a vault is configured, and an
unreachable vault never delays or blocks the deletion of your Adepthood data.

## For maintainers

The export manifest is total by construction: every table in the ORM metadata
must carry a rule saying it is exported (and under what name) or saying why it
is not. Adding a model without adding a rule fails
`test_manifest_covers_the_live_schema`. A missing export rule would not break
the endpoint — it would quietly stop handing back part of somebody's journal,
which is why the check exists rather than a list.

Both features resolve "whose rows are these" through the one predicate in
`backend/src/domain/ownership.py`, so an export and a deletion can never
disagree about what belongs to an account.

The archive is streamed, a keyset page at a time, and every value is read off a
mapped attribute so `EncryptedString` decrypts on the way out.
`test_export_emits_plaintext_and_never_ciphertext` asserts both halves: that the
column really holds ciphertext, and that no `enc::v1::` marker reaches the
archive.

The deletion policy is total by construction: every table in the ORM metadata
must carry an entry saying whether it is erased, anonymised, or untouched, and
why. Adding a model without adding a policy entry fails
`test_policy_covers_the_live_schema`, and the deletion endpoint refuses to run
at all rather than erase part of an account and report success.

The end-to-end test seeds a row into every table the schema allows, deletes one
of two accounts, and then asserts an invariant stated without reference to the
policy: afterwards no column pointing at `user` holds the erased id, and the
address appears nowhere but the purchase receipt. The second account's rows are
counted before and after, so a sweep that took the whole table fails as loudly
as one that took nothing.
