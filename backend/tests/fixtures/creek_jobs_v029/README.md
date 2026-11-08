# Job failure code `busy` 0.29

Creek contract 0.29 adds `busy` to the closed `JobFailureCode` vocabulary of
`GET /v1/jobs/{job_id}` (Creek-Vault#2090, #2075): a durable `llm`
classification or `embeddings` link job whose pass could not take the vault
content-mutation lock within its bounded wait ends `failed` with
`failure_code: "busy"`. The pass takes that lock before touching any fragment,
so nothing was written; the condition is transient, and the caller resubmits
with backoff. Each code is served only to a caller declaring at least the minor
it was published at -- `request_key_rejected` since 0.26, `busy` since 0.29 --
and an earlier caller is served `null` for the same failure.

These three files are copied byte-for-byte from the pinned Creek-Vault commit
in `vendor.json`. The base `creek_v1` bundle and the 0.22 pin stay unchanged:
adepthood declares 0.29 on the job-status poll only when a vault's handshake
lists it in `supported_contract_minors` (else 0.26 when that is listed), and
keeps 0.22 everywhere else. Refresh this snapshot only from a reviewed
immutable commit.

The recorded SHA256 values are public artifact digests, not secrets.
