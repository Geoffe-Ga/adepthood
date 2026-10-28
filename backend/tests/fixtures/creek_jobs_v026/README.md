# Job failure code 0.26

Creek contract 0.26 adds `failure_code` to `GET /v1/jobs/{job_id}`
(Creek-Vault#1877): a classification job whose writer request key was refused
by its vendor ends `failed` with `failure_code: "request_key_rejected"`, and
every other outcome carries `null`. The key is present only for a caller that
declares minor 0.26 or later; older minors receive the unchanged body.

These three files are copied byte-for-byte from the pinned Creek-Vault commit
in `vendor.json`. The base `creek_v1` bundle and the 0.22 pin stay unchanged:
adepthood declares 0.26 on the job-status poll only when a vault's handshake
lists it in `supported_contract_minors`, and keeps 0.22 everywhere else.
Refresh this snapshot only from a reviewed immutable commit.

The recorded SHA256 values are public artifact digests, not secrets.
