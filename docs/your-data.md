# Your data

Adepthood is journal-first, and the writing is yours. This page says exactly
what that means in practice: how to delete your account, what deletion reaches,
and what deliberately survives it.

It is written for the person using the app, not only for the person building
it. Nothing here is a promise the code does not keep — every claim below is
pinned by a test in `backend/tests/test_account_deletion_policy.py`, and the
authoritative statement of it lives in `backend/src/domain/account_deletion.py`.

## Deleting your account

**Settings → Delete account.** You retype the email address you sign in with,
and the account is erased.

It is **immediate and irreversible**. There is no grace period, no
deactivation, and no support path to get any of it back. If you want a copy of
your writing, take it first.

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
