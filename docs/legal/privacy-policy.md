# Privacy policy

> **Draft, pending the owner's ratification.** Two things in this document
> are the operator's to settle and are marked `[OPERATOR]`: the contact
> address for privacy requests, and the effective date. Everything else
> describes behaviour that ships today and is pinned by automated tests in
> this repository, so a change to the code that would make a sentence here
> untrue fails a build before it reaches anyone.

Adepthood is a journal. Most of what it holds is writing nobody else was
meant to read, so this page is specific about where that writing goes, who
can read it, and what happens when you ask for it to be gone.

It describes what the software actually does at the version it ships with.
Where a protection is narrower than the word for it, the narrow version is
what is written down.

- **Effective:** `[OPERATOR]` — this policy takes effect on the day
  Adepthood is first published.
- **Companion page:** [Your data](../your-data.md) covers deletion in more
  detail.

## Who runs Adepthood

One operator runs the server, the database, and the deployment. Wherever
this page says "the operator", it means that person and anyone they
authorise to run the service.

**Contact for privacy questions and data requests:** `[OPERATOR]`.

## What you give it, and what it keeps

Nothing here is collected in the background. Everything below is either
something you typed, something you chose to send, or something the service
has to record to work at all.

**Your writing.** Journal entries, their titles, the margin notes a
reflection leaves on them, passages you promote out of an entry, answers to
course prompts, and any document you hand to the "Bring in your writing"
screen.

**What you track.** Habits, goals and goal groups, check-ins and streaks,
practices you assign yourself and sessions you log, energy plans, return
arcs, invitation history, your chosen depths, and interface state.

**Your account.** Email address, a bcrypt hash of your password (never the
password), display name, time zone, and any Google or Apple sign-in linked
to the account. Sign-in attempts made with your address are recorded with
the IP address they came from, which is how brute-force attempts are
noticed.

**What you buy.** Purchases go through Gumroad. Adepthood stores the sale
record Gumroad sends back — including the email address on it — plus the
wallet balance and the ledger of what was spent on model calls.

**Metering.** Every model call is logged with the provider, the model, the
token counts and the estimated cost. The prompt and the response are not in
that record.

## Where the writing is stored, precisely

Your entries live in the operator's PostgreSQL database.

Three things are encrypted in that database: **the body of every journal
entry**, **the text of a passage you promote out of one**, and **each
fragment of your writing held in the corpus your reflections are drawn
from**. They are encrypted with a key the operator configures, and a
production server refuses to start without one, so there is no version of
this service that quietly stores entries in the clear.

That protection is real and it is narrow, so here is its shape. The keys
belong to the operator, not to you. Encryption at rest defends against
someone who walks off with the database — a stolen backup, a copied disk.
It does not put your writing beyond the reach of the person holding the
key. **Anyone who operates Adepthood can read what is in its database.**

And not everything in an entry lives in those three columns. **A margin note
— including the sentence of yours it quotes back at you — is stored as
written**, as are course prompt answers, habit and practice records, and
the rest of what you track. Treat "encrypted" as covering the entry body,
not the whole app.

Deleting an entry inside the app hides it from every list immediately; the
row is cleared when the account is deleted.

## The three tiers, and what each one means

Every entry carries a tier you choose: **Public**, **Personal**, or
**Intimate**.

**Personal** is the default. A Personal entry is yours, and it is the tier
reflections read: its text is sent to a language-model provider when you
ask for a reflection, and up to three of your recent entries may go along
with it as context.

**Intimate** is the tier that changes what the software is allowed to do:

- An Intimate entry is **never sent to a language model**. Asking for a
  reflection on one returns without any model call at all — the request is
  refused from the stored tier on the server, before a provider client is
  built or your wallet is touched.
- An Intimate entry is **never used as context** for another entry's
  reflection. The query that gathers recent entries excludes them.
- An Intimate entry is **never replicated to a Creek Vault**. The write
  path stops before it opens a connection.

There is one exception, and it is the reason this section exists rather
than a one-line promise. A **document you upload** through "Bring in your
writing" *is* forwarded to your Creek Vault at whatever tier you picked,
Intimate included — see the next section for what a vault is and why that
is a different thing from sending it to an AI. That upload path calls no
language model at any tier. If you have not configured a vault, the upload
has nowhere to go and the screen tells you so.

**Public** behaves as Personal does for everything above; the name
anticipates sharing that does not exist yet.

## Who else receives your data

Five parties, and nothing else. There is no advertising, no analytics
service, no tracking SDK, and no data broker anywhere in this app.

**The language-model provider** (Anthropic or OpenAI, depending on how the
deployment is configured, or on your own key if you supply one). It
receives: the body of a non-Intimate entry when you ask for a reflection or
an essay, up to three recent non-Intimate entry bodies as context, and the
photograph of a handwritten page when you ask for it to be transcribed. It
never receives an Intimate entry. If you bring your own key, the call goes
to your account with that provider; the key is used for that one call and
is never stored on the server.

**Your Creek Vault**, only if one is configured. A vault is a corpus of
your own writing on infrastructure the operator arranges, reached over
ordinary HTTPS. It receives non-Intimate entry bodies as they are written,
and documents you upload at any tier. Every request declares a tier
ceiling, so the vault is told what it is allowed to do with what it was
sent.

Three things are worth knowing about a vault. It is **optional** — with
none configured, none of this happens and the app is otherwise unchanged.
It belongs to **one named account per deployment**: the server binds a
vault to a single user, and every other account falls back to a local
no-vault path, so nobody's writing reaches somebody else's corpus. And a
copy already sent is **not withdrawn** — deleting an entry in the app, or
re-marking it Intimate afterwards, drops Adepthood's handle to it but does
not reach into the vault to remove it, because no such command exists yet.
Deleting your Adepthood account does not purge a vault either; [Your
data](../your-data.md) explains what to run instead.

**Gumroad**, for purchases. It receives what you type into its own
checkout, which Adepthood never sees; Adepthood sends it a licence key to
verify and receives back the sale record it keeps.

**Sentry**, if — and only if — the deployment configures it. It is how a
crash becomes visible to the operator instead of vanishing. What it
receives is the exception, its type and message and stack, plus a request
id, path and method. What it does not receive is the rest of the request:
the body, the headers, log breadcrumbs, and the local variables of every
stack frame are stripped from each event before it is sent, credential-
shaped text is redacted, and an over-long exception message is truncated.
Those are the four channels through which a journal entry could otherwise
reach a monitoring vendor, and each is closed twice — once by turning the
capture off, once by deleting it on the way out. A deployment that sets no
Sentry credentials sends nothing anywhere and logs the same crash locally.

**An email relay**, when the deployment is configured to send mail. It
carries password-reset messages to your address and nothing else.

One more, on the device rather than the server: turning on habit reminders
asks the operating system's push service for a token, which is kept on your
device. The reminders themselves are scheduled locally — their text never
leaves your phone, and no server holds your push token.

## Links that leave the app

Some places in Adepthood hand you to somebody else's website — the privacy
policy and terms you are reading, and the Discord invite for the Digital
Sangha. Following one opens your ordinary browser or the other app, and from
that point you are their visitor under their terms and their privacy policy,
not this one.

The Discord invite is worth saying plainly. Adepthood sends Discord nothing
about you: no account is linked, no identifier is passed, no message is
posted, and nothing you write here is carried across. Adepthood is not told
whether you followed the link, whether you stayed, or who you spoke to, and
what you do there never comes back. It is a door, and it only opens outward.
Discord is optional in the same way every other depth is: turning the Sangha
off in Settings removes the door, and the choice is remembered.

## What is on your device

Your session token and, if you supply one, your model provider key are held
in the platform's secure store. Preferences, cached lists and interface
state are held in ordinary app storage. Uninstalling the app removes all of
it; it does not delete your account.

## Camera, photos and microphone

Adepthood asks for the **camera** so you can photograph a handwritten page
for transcription, and for the **photo library** so you can use an image as
a meditation card. It is asked at the moment you use the feature and you
can decline; nothing else in the app changes.

It does not ask for the microphone and does not record audio. The only
audio it uses is the bells it plays during a practice.

## Deleting your account

**Settings → Delete account.** You retype your email address and the
account is erased. It is immediate and irreversible: no grace period, no
deactivation, no support path to recover any of it. Your session stops
working on every device.

Everything of yours goes — entries at every tier, margin notes, habits,
goals, practices, course progress, sign-in records, the account row itself.

Three things survive, each for a stated reason: a practice you contributed
to the shared catalogue stays and stops naming you, because other people
may already have it assigned; a **purchase receipt** stays with the email
address on it, because that address is how something you paid for is
matched back to you, and because retaining a payment record is the ordinary
carve-out in data-protection law; and a note that a deletion happened —
date, counts, and an internal id that now names nobody.

[Your data](../your-data.md) says all of this at greater length, including
what happens to a Creek Vault.

## Getting a copy of your writing

There is no export button yet. It is being built, and until it exists a
copy is produced by hand: ask at the contact address above and one will be
sent to you.

Because deletion is immediate and total, **take a copy before you delete**.
Nothing here can undo it afterwards.

## Children

Adepthood is not built for children and is not directed at them. It is
intended for people aged 16 and over. If you believe a child has created an
account, write to the contact address above and it will be deleted.

## Changes

This document is versioned in the repository it is served from, so every
change to it is public, dated, and readable as a diff against the version
before it. A change that narrows any protection described here is a change
to the code as well, and the two land together.
