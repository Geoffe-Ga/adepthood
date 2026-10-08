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
- **Companion page:** [Your data](../your-data.md) covers taking a copy and
  deleting, in more detail.

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
wallet balance and the ledger of what was spent on model calls. Once a
licence is redeemed, Adepthood also records which account it is bound to,
keyed by Gumroad's identifier for the sale; the licence key itself is never
stored.

**Metering.** Every model call is logged with the provider, the model, the
token counts and the estimated cost. The prompt and the response are not in
that record.

## Where the writing is stored, precisely

Your entries live in the operator's PostgreSQL database.

Everything you write in the journal is encrypted in that database, and so
is the text derived from it: **the body and title of every entry**, **the
text of a passage you promote out of one**, **each fragment of your writing
held in the corpus your reflections are drawn from**, **every margin note —
including the sentence of yours it quotes back at you**, **the suggestions
drawn from your entries**, and **your answers to the weekly prompts**. So is
the writing you do away from the journal: **the reflection and the insight
you write after sitting a practice**, and **everything you write in a beta
feedback report** — none of these is part of any entry, and all of them are
protected for the same reason. One thing that is not your writing is
encrypted alongside all of it: **the access key for a private vault, if you
connect one**. They are encrypted with a key the
operator configures, and a production server refuses to start without one, so
a production deployment of this service cannot quietly store your writing in
the clear.

Some of what is derived from your writing is not text, and it is stored
unencrypted. **Frequency weights**: when the corpus is on, each passage in it
is stored with a score for each frequency the sorting found in it. **Embeddings**: the corpus can also hold, for each passage, an embedding —
a list of numbers a model computes from the text so that passages with
similar meaning can be found. **Vault tags**: when an entry is sent to a Creek
Vault, the frequency and Wavelength-phase labels the vault gives back are kept
on the entry. None of these is your words, but each says something about
them, and anyone who can read the database can read them.

**If you connect your own vault or activate a managed one**, Adepthood stores
the address and access credential and uses them only to send your own entries
to that vault. Once stored, the credential is never returned by a screen or API
and is deleted with your account. The same caveat below applies to it as to
your writing: it is encrypted with the operator's key, so it is protected
against a stolen disk and not against the operator. If you use no vault, none
of this applies to you and nothing of yours leaves for one.

That protection is real and it is narrow, so here is its shape. The keys
belong to the operator, not to you. Encryption at rest defends against
someone who walks off with the database — a stolen backup, a copied disk.
It does not put your writing beyond the reach of the person holding the
key. **Anyone who operates Adepthood can read what is in its database.**

The line falls between what you **write** and what you **record**. Every
piece of prose you compose is encrypted, wherever in the app you composed
it — the journal is where most of it happens, not where the protection
stops. What you record around that writing is not: habit names, goal titles
and descriptions, the names you give goal groups and practices, and the
measurements in a practice log — how long you sat, in what mode, whether you
finished — are stored as written.

One of those is in the clear for a reason worth stating plainly. A habit name
is checked against your other habit names so the app can refuse a duplicate,
and encrypted text comes out different every time even for the same words, so
a name it could not read is a name it could not check. The others are labels
and numbers rather than writing — except a goal description, which can run
long enough to be writing, and which is stored in the clear all the same.
This page names it here rather than let the paragraph above be read as
covering it.

Deleting an entry inside the app hides it from every list immediately, and
takes with it the copy in the corpus described below, so nothing you have
deleted goes on being read back to you. "Deleting one page" further down
says how far that reaches and what is left behind.

## The three tiers, and what each one means

Every entry carries a tier you choose: **Public**, **Personal**, or
**Intimate**.

**Personal** is the default. A Personal entry is yours, and it is the tier
reflections read: its text is sent to a language-model provider when you
ask for a reflection, and up to three other pieces of your own writing may
go along with it as context. Those three are **passages chosen out of the
corpus of your own writing** — the writing you have brought into Adepthood,
sorted by which of the ten frequencies it speaks in and picked for the one
you are standing in now — or, while that corpus is still empty, **your
recent entries**. It is one source or the other, never both, and never more
than three either way. Reflections the app has already written you may go
with it too, for the single purpose of not repeating themselves; the section
on who receives your data says how many.

**Intimate** is the tier that changes what the software is allowed to do:

- An Intimate entry is **never sent to a language model**. Asking for a
  reflection on one returns without any model call at all — the request is
  refused on the server, before any connection to a language model is
  opened or your wallet is touched.
- An Intimate entry is **never used as context** for another entry's
  reflection. Neither source can produce one: the query that gathers recent
  entries excludes them, and an Intimate entry is never put into the corpus
  in the first place — the database refuses to hold one at that tier.
- An Intimate entry is **never replicated to a Creek Vault**. The write
  path stops before it opens a connection.

A **document you upload** through "Bring in your writing" follows the same
Intimate boundary. An Intimate document is refused before a vault or language
model is contacted. At Public or Personal, it may be forwarded to your Creek
Vault; that upload path itself calls no language model.

A document has no other destination. If no Creek Vault is ready for your
account — none is connected, the one you have is still being set up, or the
address on record for it is one Adepthood will not connect to — a document
you bring in has nowhere to go: it is not read, sorted or stored, no
language model is sent it, and you are told there is no place for it yet.

**Public** behaves as Personal does for everything above; the name
anticipates sharing that does not exist yet.

## The corpus, and how anything gets into it

**Nothing you write is put into that corpus unless you turn it on.** It is
off for every account until you say otherwise, and asking is a separate
question from the tier you pick for a piece of writing — a tier is a
decision about one entry, not permission to sort your journal into a
searchable store.

There is a switch per kind of material, and there are two kinds. The first
is **what you write in Adepthood itself**: the entries you compose here.
The second is **documents you bring in**, a file you hand over rather than
type. They are separate decisions, separately dated, and each is off until
you make it — agreeing that your entries may be sorted is not agreeing that
your documents may be.

No document reaches this corpus, whichever way the switch for documents is
set. A document you bring in goes to your Creek Vault and nowhere else, and
with no vault ready for your account it has nowhere to go (see above). The
switch for documents is still offered and your decision is still recorded,
but today it lets nothing in. Documents sorted into your corpus before this
change stay stored there but are no longer used for reflections or sent to
any language model, and turning off "Documents you bring in" deletes them.

Turning it on has three consequences worth knowing before you do.

The first is that **each entry is sent once to the language-model provider
to be sorted** — one call per entry you write, and one more if you go back
and change its wording or its tier. That call reads the entry and answers
with which of the ten frequencies it speaks in; the answer, and your text,
are then stored in the corpus. Nothing else in Adepthood does this, so with
the switch off no entry of yours is ever sent anywhere at save time.

The second is that **it reaches back over what you have already written.**
The switch is permission for your journal, not only for the part of it you
have not written yet, so entries that were already there are sorted on the
same terms as a new one — one call each, and never an Intimate entry, and
never an entry you have deleted. This happens while you wait, and it is
bounded: a long journal is sorted as far as one request can reasonably go,
and whatever is past that is simply left unsorted rather than sent
somewhere later.

The third is that **turning it back off deletes what it collected.** The
corpus copies of your writing are removed, not merely hidden, and the
entries themselves are untouched in your journal. Your decisions about this
are kept as a dated record — which kind of material, what you decided, when
— so that "did I agree to this, and when?" has an answer. That record holds
no words of yours.

An Intimate entry is never sorted into the corpus whatever this switch
says; the tier section above is where that promise is written out in full.

## Who else receives your data

The parties below, and nothing else. There is no advertising, no analytics
service, no tracking SDK, and no data broker anywhere in this app.

**The language-model provider** (Anthropic or OpenAI, depending on how the
deployment is configured, or on your own key if you supply one). It
receives: the body of a non-Intimate entry when you ask for a reflection or
an essay, up to three other pieces of your own non-Intimate writing as
context — passages chosen out of the corpus of your own writing, or your
recent entries while that corpus is empty — **at most two** of the
reflections it has already written you, which quote and paraphrase the
entries they were written about, sent back only so that the same thing is
not said to you twice and never as a voice to imitate; never one written
about an Intimate entry, and never one about an entry you have deleted —
the photograph of a
handwritten page when you ask for it to be transcribed, and, **only if you
have turned the corpus on**, the body of each non-Intimate entry once as it
is saved — and once for each non-Intimate entry that was already in your
journal on the day you turned it on — so that it can be sorted into the ten
frequencies. It never receives an Intimate entry, and Adepthood does not
send it a document you bring in. If you bring your own key, the production app sends it
over HTTPS to Adepthood's server in the `X-LLM-API-Key` header. Adepthood
forwards it over HTTPS to your account with the selected provider for that
call. The key is used for that one call and is never persisted, logged or
returned by Adepthood.

**Your Creek Vault**, only if one is configured. A vault is a corpus of
your own writing on infrastructure the operator arranges, reached over
ordinary HTTPS. It receives non-Intimate entry bodies as they are written,
and non-Intimate documents you upload. Every request declares a tier
ceiling, so the vault is told what it is allowed to do with what it was
sent.

Four things are worth knowing about a vault. It is **optional** — with
none configured, none of this happens and the app is otherwise unchanged.
Each connection or allocation is **bound to one named account**: another
account cannot read or write through it, so nobody's writing reaches somebody
else's corpus. An ordinary Fly vault activated by Adepthood is
**provider-managed and operator-readable**: Fly and privileged Adepthood or
Creek operators can access its stored bytes and restart it without you. It is
not confidential compute, there is no user-held recovery key, and Intimate
journal entries are never replicated to it. Finally, deleting or re-marking a
mirrored journal page withdraws its content-free stable identity before
Adepthood reports completion. Deleting an account requests teardown of the
managed vault Adepthood created for you; a vault you connected yourself still
requires its owner to perform any account-wide purge.
[Your data](../your-data.md) explains both cases.

**Your Creek Vault's model provider**, only if the vault's own deployment
allows it to use a cloud model (its `CREEK_CLOUD_CONSENT` setting). A vault
sorts and reflects on what it is sent. When it is allowed a cloud model for
that work, what it holds of yours — non-Intimate entries and documents — goes
to that model's provider under the vault's configuration, not Adepthood's.
Which provider that is depends on how the vault is set up.

**Railway**, the platform the server and its database run on. Everything the
database holds is on Railway's machines, and so is the key the server
decrypts your writing with, so the encryption described above does not keep
your writing from the host any more than it does from the operator. Any
platform backups of the database are held by Railway too ("Deleting your
account" below says how long they are kept).

**Encrypted copies kept off the hosting platform by the operator**, on our
backup schedule. Once a week the operator copies the whole database,
encrypts the copy, and keeps it somewhere other than Railway, so the service
can be recovered if the platform is lost. Where those copies are kept is not
yet settled. "Deleting your account" below says how long they are kept.

**Fly.io**, only if Adepthood activated a managed vault for you. Fly hosts
that vault, and as the vault paragraph above says, Fly and privileged
Adepthood or Creek operators can access what it stores.

**Gumroad**, for purchases. It receives what you type into its own
checkout, which Adepthood never sees; Adepthood sends it a licence key to
verify and receives back the sale record it keeps.

**Sentry**, if — and only if — the deployment configures it. It is how a
crash becomes visible to the operator instead of vanishing. Reports can come
from two places, and neither captures anything automatically.

From the server, a report is made when the server meets an error it did not
handle, and each one is rebuilt from a short list of fields before it is sent.
It names the release and environment that failed, a request id, the
request's method and route — the route's pattern, such as
`/journal/{entry_id}`, not the address you visited — and, for each exception,
its type, a fixed error code, and the file, function and line of each stack
frame. The exception's message is never sent: the fixed error code stands in
for it, and that code is written into the program, never taken from anything
you typed. Nor is anything else sent — not the body or headers of the
request, not log records, not the source lines or local variables of any
frame. Credential-shaped text in what is left is redacted as a second,
separate lock.

From the app, if it was built with a Sentry address, a crash that reaches one
of the app's error screens is reported straight from your device. That report
names the error's type, the component stack — the chain of screen components
the crash happened inside — and which error screen caught it, plus the app's
release and environment. The error's message is withheld here too. Because
the report is sent from your device, Sentry also sees the network address it
came from and the ordinary details any connection carries, such as the
browser's or app's version string.

A deployment that sets no Sentry credentials, and an app built without a
Sentry address, sends nothing anywhere and logs the same crash locally.

**An email relay (Resend, or the deployment's own mail server)**, when the
deployment is configured to send mail. It carries password-reset messages to
your address and nothing else.

**Google and Apple**, if you sign in with one of them. Signing in happens
between you and that company, under its own terms, and Adepthood receives the
signed token it issues. To check that token, the server fetches the
company's published keys; that request carries nothing about you.

One more, on the device rather than the server: turning on habit reminders
asks the operating system's push service for a token, which is kept on your
device. The reminders themselves are scheduled locally — their text never
leaves your phone, and no server holds your push token.

## Beta feedback

If you are in the private beta you can send a report about something that is
broken, confusing, worth building, or worth saying thanks for. A report is the
only place in this app where you are writing **to the people who build it**
rather than to yourself, so it is worth being exact about what a report
carries.

**What you write.** A one-line summary, plus up to three longer answers: what
you were trying to do, what you expected, and what happened instead. These are
your words and they are treated as your writing everywhere else on this page —
encrypted in the database, included in your export, erased with your account,
and never reproduced in a log, an error report, or a crash trace.

**What the app attaches.** Seven fields, and no eighth. The app may send: the
**canonical screen** you were on, as a short internal name like
`journal.shelf`; the **control** you used or the stable error code you saw; the
**platform** — iOS, Android, or web; the **app build** you are running; a
**viewport class** — compact, regular, or expanded, never your exact screen
size; your **locale**, as a language and optional region; and a **correlation
id**, a random label the app makes up for one sitting, so reports from that
sitting can be matched to each other and nothing else.

That list is an allowlist enforced by the server, not a filter applied
afterwards. A report carrying any other field is refused outright, and nothing
is stored. There is no mechanism here to send a log bundle, a stack trace, a
request or response body, a header map, a web address with a query string, a
vault address, or the contents of the screen — and no field these could be
smuggled into: the screen and control names are restricted to short internal
tokens, which a URL or a trace cannot be spelled as.

**Who reads it.** The operator, for the purpose of fixing and improving the
app. Reports are not shown to other users, not published, and not sold. If the
report is about something on a screen, the operator sees the screen's name and
your words about it — not the screen.

**What the operator adds.** While working through reports, the operator can
give each one a **triage status** — new, triaged, planned or closed — mark it
as a **duplicate** of another report, and write **private notes** about it.
Every one of those changes is recorded in an **audit trail** naming which
operator made it and when. These are the operator's working notes about your
report, not your writing: only operators can see them, they are never shown to
you or to anyone else in the app, and they are **not included in your export**.
Operator notes are encrypted in the database the same way your own words are.
The operator's view of a report also shows its correlation id, so the report
can be matched to that session's telemetry; the inbox list and the summary
draft described next leave it out. The status, duplicate link, notes and audit
trail are deleted together with the report they belong to — by the retention
sweep below, or when you delete your account.

**What may be posted publicly.** Your report's words are never published. An
operator may post a summary to the project's public issue tracker, written in
the operator's own words, together with these non-identifying technical details
and nothing else: the report's **category**, its **impact**, the **canonical
screen**, the **control or error code**, the **build family** (for example
`1.4`, not the exact build), the **platform**, the **viewport class** and the
**locale** — plus how many reports it covers and their `FB-` references. An
operator may also choose to include private notes that operators wrote. Your
account identity and your own text are never included: not your summary, not
your answers, not your email address, not the correlation id. The app only
prepares this **summary draft** for the operator to copy or download; nothing
is sent anywhere automatically.

**How long it is kept.** A report is kept for **180 days**. Past that, it is
deleted the next time the operator runs the maintenance sweep — there is no
automatic timer, so the exact day depends on when that sweep is run. You do not
have to ask for it, and deleting your account removes every report you have
filed at a moment you choose.

**Your copy, and getting rid of it.** Every report you have filed is in your
export, in full, under `feedback_reports` — with two exceptions: the retry token
the app sends so a double-tap cannot file the same report twice is dropped,
because it is a transport detail and not something you wrote; and the
operator's triage status and duplicate link are dropped, because they are the
operator's, not yours. Deleting your
account deletes every report you filed, immediately, along with everything
else.

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

## Deleting one page

**Journal → the page's Delete.** You can delete a single entry without
touching anything else about your account. The shelf asks once, and then
that page leaves your journal: it is gone from every list, and from
everything a reflection is allowed to read.

Two things about that are worth stating exactly. **The copy in the corpus
goes with it** — if the entry had been sorted, its fragments are removed in
the same moment, so writing you deleted stops being sent to a language
model as context for what you write next. And **the row is not taken out of
the database when you confirm**: it is marked deleted and kept out of every
read path, which is what keeps the record of model calls made against it
from pointing at nothing, and it is cleared when you delete your account.
Nothing in the app will show that page to you again, no support path will
bring it back, and it is left out of an export — so take a copy first if you
might want it.

## Deleting your account

**Settings → Delete account.** You retype your email address and the
account is erased from the live service straight away. It cannot be undone:
no grace period, no deactivation, no support path to recover any of it. Your
session stops working on every device.

Removed from the live service: entries at every tier, margin notes, habits,
goals, practices, course progress, beta feedback reports, sign-in records,
the account row itself.

Three things survive, each for a stated reason: a practice you contributed
to the shared catalogue stays and stops naming you, because other people
may already have it assigned; a **purchase receipt** stays with the email
address on it, because that address is how something you paid for is
matched back to you, and because retaining a payment record is the ordinary
carve-out in data-protection law; and a note that a deletion happened —
date, counts, and an internal id that now names nobody.

**Backups age out; they are not edited.** The database is backed up, and a
backup taken before you deleted still holds what your account held then, with
your writing encrypted in it as it is in the database. No backup is altered to
remove one account. Our backup schedule keeps the hosting platform's daily
backups for 6 days and the weekly encrypted copies kept off the platform for
90 days; those off-platform copies are made, and the expired ones deleted, by
the operator by hand. On that schedule, the last copy of your data in
Adepthood's own backups ages out within about 97 days of your deletion. That
bound is Adepthood's alone: each party under "Who else receives your data"
keeps what it received under its own retention, which this page does not set.

If the operator ever has to restore the database from a backup taken before
you deleted, that backup still holds your account, so a restore could bring
your data back. The restore procedure has a step that re-applies deletions
made since the backup before the service goes back online, but that step is
still a draft and relies on a record of deletions whose keeping is not yet
settled. <!-- DRAFT for owner (#3063 AC17): once tombstone custody is decided
and the "Suppress resurrected deletions" step in DEPLOYMENT.md is ratified,
replace this paragraph with: "If we ever have to restore from a backup,
we re-apply deletions made since that backup before the service goes back
online." -->

[Your data](../your-data.md) says all of this at greater length, including
what happens to a Creek Vault.

## Getting a copy of your writing

**Settings → Export my data.** The app asks the server for your archive and
saves it to your device: everything in a JSON file that can be read back
in, and your journal alone as Markdown, oldest first, for reading. Entries
you deleted are in neither.

The archive is decrypted on the way out, so what lands on your device is a
plaintext copy of your journal — keep it where you would keep a paper one.
Three kinds of thing are deliberately left out, and the file itself lists
them with the reason for each: credentials, the records the system kept
about your use of the app, and content that was never yours to take.
[Your data](../your-data.md) walks through all three. That an export
happened is noted — your account id and how many records went, and not a
line of what they said.

Because deletion takes effect at once and cannot be undone, **take a copy
before you delete**. Nothing here can undo it afterwards.

## Children

Adepthood is not built for children and is not directed at them. It is
intended for people aged 16 and over. If you believe a child has created an
account, write to the contact address above and it will be deleted.

## Changes

This document is versioned in the repository it is served from, so every
change to it is public, dated, and readable as a diff against the version
before it. A change that narrows any protection described here is a change
to the code as well, and the two land together.
