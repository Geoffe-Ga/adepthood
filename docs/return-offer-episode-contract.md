# Return offer identity and decline rollout

GET `/metta-return` returns `offer_episode`, a stable opaque account-bound identity for the current eligible episode, or `null` when none exists. The handle correlates a choice with its offer; authentication still uses the caller's credential. Clients must round-trip the observed value rather than reconstructing stage or cycle coordinates.

POST `/metta-return/offer/dismiss` requires `{ "expected_offer_episode": "<observed identity>" }`. A stale or another account's identity receives 409; an omitted identity receives 422. Older clients' unbound dismissal requests are intentionally refused. Deploy the updated server and client together; a client must refresh state after 409 rather than retrying its choice against a newer invitation.

Repeated submissions for the same current episode remain idempotent. Existing server dismissal rows and historical coordinates are unchanged. If progress advances around the dismissal commit, the response reports the actual returned episode's dismissal state. No Return arc, eligibility, cadence or default changes accompany this contract.

Local choices use captured account and opaque episode identities, including retries after uncertain outcomes. A later episode remains a fresh invitation. The previous device-wide boolean remains untouched and unassigned because it cannot establish which episode the person declined. Rolling back the client must not turn that unknown value into an account or episode choice; keep server validation in place to refuse unbound retries.
