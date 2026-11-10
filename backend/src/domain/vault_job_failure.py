"""Which published job failure codes settle a run, and which minor published each.

Creek's ``JobFailureCode`` (:class:`~domain.creek_vault.VaultJobFailureCode`)
names why a durable pipeline job failed. The two members ask for opposite
remedies: ``request_key_rejected`` (contract 0.26) is final -- the same key is
refused again -- while ``busy`` (0.29, Creek-Vault#2090) is transient lock
contention that a resubmit with backoff clears. Each is served only to a poll
declaring at least the minor it was published at, so the job poll declares the
newest one a vault lists.

Its own module rather than more of :mod:`domain.creek_vault`, which imports
nothing from here: the vocabulary stays there beside the job it describes, and
the retry policy over it lives here.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Final

from domain.creek_vault import JOB_FAILURE_CODE_SINCE_MINOR, VaultJobFailureCode

#: The Creek minor that published ``busy`` (Creek-Vault#2090, #2075). A caller
#: declaring 0.26-0.28 is served ``null`` for the same failure, so the job poll
#: declares this minor -- again only to a vault whose handshake lists it -- to
#: learn that a failed pass met content-lock contention rather than some fault.
BUSY_FAILURE_CODE_SINCE_MINOR: Final = "0.29"

#: The minor Creek published each code at -- total over :class:`VaultJobFailureCode`.
JOB_FAILURE_CODE_SINCE_MINOR_BY_CODE: Final[Mapping[VaultJobFailureCode, str]] = {
    VaultJobFailureCode.REQUEST_KEY_REJECTED: JOB_FAILURE_CODE_SINCE_MINOR,
    VaultJobFailureCode.BUSY: BUSY_FAILURE_CODE_SINCE_MINOR,
}

#: Published reasons a later attempt may clear on its own. A failed job naming
#: one joins the bounded retry, exactly as an unnamed failure does.
TRANSIENT_JOB_FAILURE_CODES: Final = frozenset({VaultJobFailureCode.BUSY})


def failure_code_is_final(code: VaultJobFailureCode | None) -> bool:
    """Whether a failed job's reason settles its run now, instead of joining the bounded retry.

    Only a reason that would meet every resubmit unchanged is final -- a refused
    writer key is refused again. ``None`` (no reason, or one this build cannot
    name) and a transient reason such as ``busy`` say time may change the
    answer, so the pass is retried with backoff.
    """
    return code is not None and code not in TRANSIENT_JOB_FAILURE_CODES
