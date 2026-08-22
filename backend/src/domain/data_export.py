"""What a data export carries out of the database, and what it leaves behind.

GDPR Art. 20 asks for portability. A journal-first product owes the same thing
for a reason that predates the regulation: a journal you cannot get back out is
not yours. So the question this module answers is "which of the forty tables in
this schema hold writing the account made, and which hold something else".

The answer is **total by construction**, like the deletion policy it sits
beside. Every table in the ORM metadata must carry a rule — :class:`Included`
with the collection name it appears under, or :class:`Omitted` with the reason
it does not — and :func:`manifest_gaps` reports the ones that do not. A model
added later without a rule is a failing test rather than a silent hole, which
matters more here than almost anywhere: a missing export rule does not break
the endpoint, it just quietly stops handing back part of somebody's journal.

Two principles decide which side a table falls on.

*Include what the account authored or chose*, and what was derived directly
from it — the ontologized corpus is the account's own sentences, reclassified,
so leaving it out would be leaving out the journal in a different shape.

*Omit what the system recorded about the account's use of the product*:
metering, security telemetry, interface state, shared catalogue content the
account did not write, and — emphatically — live credentials. An export is a
plaintext file that ends up on a laptop, in a cloud drive, in an email. A
working key to a third-party service does not belong in one.

Ownership is not restated here: :mod:`domain.ownership` holds the one predicate
both this and the deletion sweep use, so the two can never disagree about which
rows are whose.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from domain.ownership import OwnedBy
from models.completion_suggestion import CompletionSuggestion
from models.content_completion import ContentCompletion
from models.corpus_fragment import CorpusFragment
from models.energy_plan import EnergyPlan
from models.goal import Goal
from models.goal_completion import GoalCompletion
from models.goal_group import GoalGroup
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia
from models.metta_return_arc import MettaReturnArc
from models.metta_return_habit_release import MettaReturnHabitRelease
from models.metta_return_offer_dismissal import MettaReturnOfferDismissal
from models.practice import Practice
from models.practice_recipe import PracticeRecipe, PracticeRecipeStep
from models.practice_session import PracticeSession
from models.practice_tag import PracticeTag
from models.promoted_quote import PromotedQuote
from models.prompt_response import PromptResponse
from models.stage_progress import StageProgress
from models.user import User
from models.user_depth_preferences import UserDepthPreferences
from models.user_practice import UserPractice

if TYPE_CHECKING:
    from sqlalchemy import MetaData
    from sqlmodel import SQLModel

# The archive's self-description. A file found on a disk three years from now
# has to be able to say what it is without the app that wrote it.
EXPORT_FORMAT = "adepthood-export"
EXPORT_FORMAT_VERSION = 1

# Rows read per round trip. Small enough that the first bytes leave before a
# long corpus has been read at all (which is what keeps a gateway from timing
# out on a decade of journalling), large enough that a full export is not a
# thousand queries.
EXPORT_PAGE_SIZE = 100


@dataclass(frozen=True)
class Included:
    """A table whose rows go into the archive, under ``key``.

    ``drop_columns`` names what is stripped from each row: credentials, and
    machine-internal values (an embedding vector, a monthly-usage counter) that
    mean nothing outside the system that produced them. The ownership column
    itself is dropped automatically — the whole file belongs to one account, so
    repeating its id on every row is noise.
    """

    key: str
    owned_by: OwnedBy
    model: type[SQLModel]
    rationale: str
    drop_columns: tuple[str, ...] = ()

    def dropped(self) -> frozenset[str]:
        """Every column withheld from this table's rows, ownership included."""
        withheld = set(self.drop_columns)
        if self.owned_by.through is None:
            withheld.add(self.owned_by.column)
        return frozenset(withheld)


@dataclass(frozen=True)
class Omitted:
    """A table the archive deliberately leaves out, with the reason it does."""

    rationale: str


ExportRule = Included | Omitted


def _include(
    key: str,
    model: type[SQLModel],
    rationale: str,
    *,
    column: str = "user_id",
    drop_columns: tuple[str, ...] = (),
) -> Included:
    """Shorthand for the common case: rows keyed directly on ``user.id``."""
    return Included(
        key=key,
        owned_by=OwnedBy(column),
        model=model,
        rationale=rationale,
        drop_columns=drop_columns,
    )


# --------------------------------------------------------------------------
# The manifest itself. Alphabetical for review; the order rows are written in
# is derived from the collection names, not from this dict.
# --------------------------------------------------------------------------
MANIFEST: Mapping[str, ExportRule] = {
    "accountdeletionaudit": Omitted(
        "Content-free receipts of account deletions. By the time one exists "
        "the account it describes is gone, so it can never be anybody's to "
        "take with them.",
    ),
    "authidentity": Omitted(
        "Opaque Google / Apple subject identifiers. They are credentials for "
        "somebody else's system and mean nothing outside this one.",
    ),
    "completionsuggestion": _include(
        "completion_suggestions",
        CompletionSuggestion,
        "Passages the app spotted in the account's own entries and offered as "
        "check-ins, with the account's answer.",
    ),
    "contentcompletion": _include(
        "chapters_read",
        ContentCompletion,
        "Which chapters of the course the account marked read.",
    ),
    "corpusfragment": _include(
        "corpus_fragments",
        CorpusFragment,
        "The ontologized corpus: the account's own writing, classified into "
        "the ten frequencies. Derived from the journal rather than authored "
        "separately, which is exactly why leaving it out would be leaving out "
        "the journal in another shape.",
        drop_columns=("embedding",),
    ),
    "coursestage": Omitted(
        "The shared 36-week curriculum, identical for every account. Nobody "
        "wrote it here and nobody takes it away.",
    ),
    "energyplan": _include(
        "energy_plans",
        EnergyPlan,
        "The account's energy budget and how it moved.",
    ),
    "entitlement": Omitted(
        "The course-access grant. An operational record of a purchase rather "
        "than something the account wrote; the receipt lives with the seller.",
    ),
    "goal": Included(
        key="goals",
        owned_by=OwnedBy("habit_id", through="habit"),
        model=Goal,
        rationale="Goals belong to a habit, and every habit belongs to one account.",
    ),
    "goalcompletion": _include(
        "goal_completions",
        GoalCompletion,
        "Every check-in the account logged — the raw material of every streak.",
    ),
    "goalgroup": _include(
        "goal_groups",
        GoalGroup,
        "The account's own groupings of its goals. Shared community templates "
        "carry no user_id, so scoping by it cannot reach one.",
    ),
    "gumroadsale": Omitted(
        "A payment record, carrying processor identifiers that mean nothing "
        "outside the checkout that issued them. Retained under GDPR Art. "
        "17(3) and available from the seller, not from here.",
    ),
    "habit": _include(
        "habits",
        Habit,
        "Every habit the account built, and its goals with it.",
    ),
    "invitationsignal": Omitted(
        "Which invitations the interface showed and how they were dismissed. "
        "Interaction telemetry about the app, not writing by the account.",
    ),
    "journalentry": _include(
        "journal_entries",
        JournalEntry,
        "The writing. Encrypted at rest and decrypted on the way out, because "
        "an archive of ciphertext the account cannot read is not a copy of "
        "anything. This is the row the whole feature exists for.",
        drop_columns=("vault_ref", "vault_tags"),
    ),
    "llmusagelog": Omitted(
        "Per-request AI metering: token counts and prices. Operational "
        "accounting about the account's usage, not anything it wrote.",
    ),
    "loginattempt": Omitted(
        "Sign-in attempts and the IP addresses they came from. Security "
        "telemetry, kept to defend the account rather than to describe it — "
        "and keyed on a typed address, so it is not reliably even this "
        "account's.",
    ),
    "marginalia": _include(
        "margin_notes",
        Marginalia,
        "Notes the account wrote in the margins of its own entries, and the "
        "passages they anchor to.",
    ),
    "mettareturnarc": _include(
        "return_arcs",
        MettaReturnArc,
        "The account's returns after a lapse — its own record of coming back.",
    ),
    "mettareturnhabitrelease": _include(
        "released_habits",
        MettaReturnHabitRelease,
        "Habits the account chose to let go of during a return.",
    ),
    "mettareturnofferdismissal": _include(
        "declined_return_offers",
        MettaReturnOfferDismissal,
        "Returns the account was offered and declined — a choice it made, "
        "not a measurement taken of it.",
    ),
    "passwordresettoken": Omitted(
        "Live recovery credentials. Anything that can be redeemed for a "
        "session has no business in a file that lands on a laptop.",
    ),
    "practice": Included(
        key="practices_you_contributed",
        owned_by=OwnedBy("submitted_by_user_id"),
        model=Practice,
        rationale=(
            "Practices the account wrote and gave to the shared catalogue. "
            "Deletion anonymises these rather than erasing them, because "
            "other people use them — but the account still authored them, so "
            "an export hands them back."
        ),
    ),
    "practicerecipe": _include(
        "practice_recipes",
        PracticeRecipe,
        "Recipes the account composed. System recipes carry no owner.",
        column="owner_user_id",
    ),
    "practicerecipestep": Included(
        key="practice_recipe_steps",
        owned_by=OwnedBy("recipe_id", through="practicerecipe"),
        model=PracticeRecipeStep,
        rationale="The steps of the account's own recipes; meaningless without them.",
    ),
    "practicesession": _include(
        "practice_sessions",
        PracticeSession,
        "Every sit the account logged, with what it noted about it.",
    ),
    "practicesessionspend": Omitted(
        "Wallet debits behind logged sessions. Accounting for the offering "
        "balance, not a record of the practice itself.",
    ),
    "practicesharelink": Omitted(
        "Share links the account minted. The token in each row is a live "
        "capability: anyone holding it can read what it points at.",
    ),
    "practicetag": _include(
        "practice_tags",
        PracticeTag,
        "Tags the account defined. System tags carry no owner.",
        column="owner_user_id",
    ),
    "promotedquote": _include(
        "promoted_passages",
        PromotedQuote,
        "Passages the account lifted out of one entry to carry into another.",
    ),
    "promptresponse": _include(
        "prompt_responses",
        PromptResponse,
        "Answers to the weekly prompts — the account's writing, in reply to "
        "the curriculum's question.",
    ),
    "revokedtoken": Omitted(
        "Expired JWT identifiers with no owner column at all. Nothing here "
        "names an account, and the rows age out on their own.",
    ),
    "stagecontent": Omitted("Shared curriculum chapters, identical for every account."),
    "stageprogress": _include(
        "stage_progress",
        StageProgress,
        "Where the account had reached in the 36 weeks, and how many times round it had been.",
    ),
    "user": Included(
        key="account",
        owned_by=OwnedBy("id"),
        model=User,
        rationale=(
            "The account itself: the address it signs in with, the name it "
            "chose, the zone its days are counted in, and when it started."
        ),
        drop_columns=(
            # A credential. Never, under any circumstances, in the archive.
            "password_hash",
            # Operational counters and flags: metering, moderation, and the
            # lifecycle bookkeeping that describes the row rather than the
            # person who owns it.
            "is_admin",
            "offering_balance",
            "monthly_messages_used",
            "monthly_reset_date",
            "password_changed_at",
            "deleted_at",
        ),
    ),
    "userdepthpreferences": _include(
        "depth_preferences",
        UserDepthPreferences,
        "Which optional depths the account chose to open. You choose your "
        "depth, so the choices are yours.",
    ),
    "userpractice": _include(
        "assigned_practices",
        UserPractice,
        "The practices the account took on, and how it customised them.",
    ),
    "useruiflags": Omitted(
        "One-time interface state — which tips have been seen. It describes "
        "the app's memory of a session, not the account.",
    ),
    "uservaultconfig": Omitted(
        "The Creek Vault the account connected, and the key that opens it. "
        "The key is a live secret for a system this export has no business "
        "copying into a plaintext file. The vault's own contents are "
        "exported from the vault.",
    ),
    "walletaudit": Omitted(
        "The offering-balance ledger. Operational accounting, and rows about "
        "other accounts' wallets are not this account's to take.",
    ),
}


def included_rules() -> Mapping[str, Included]:
    """Every table the archive carries, keyed by table name."""
    return {name: rule for name, rule in MANIFEST.items() if isinstance(rule, Included)}


def omitted_rules() -> Mapping[str, str]:
    """Every table the archive leaves out, mapped to the reason it does.

    Written into the archive itself: a file that lists what it does *not*
    contain, and why, is one a reader can trust about what it does.
    """
    return {name: rule.rationale for name, rule in MANIFEST.items() if isinstance(rule, Omitted)}


def manifest_gaps(metadata: MetaData) -> tuple[str, ...]:
    """Report every table the manifest fails to account for, in either direction.

    An empty tuple is the only acceptable answer, and the reason this function
    exists is that it stops being empty on its own: adding a model produces a
    finding without anyone remembering to come back here.
    """
    live = set(metadata.tables)
    ruled = set(MANIFEST)
    missing = [f"table {name!r} has no export rule" for name in sorted(live - ruled)]
    stale = [
        f"export rule {name!r} names a table the schema no longer has"
        for name in sorted(ruled - live)
    ]
    return tuple(missing + stale)
