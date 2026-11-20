# Pipeline status 0.34

Creek contract 0.34 adds `GET /v1/pipeline/status?limit=` (Creek-Vault#2124,
merged as #2136): every scaffolded ontology folder with its note count and the
subsystem that fills it (or the closed reason nothing does), the caller's most
recent uploads with the stages each whole-vault pass has run over them, and
the caller's newest durable pipeline jobs. It is read-only and content-free:
no body and no title crosses, and a document with any fragment above the
declared ceiling is counted in `documents_withheld` rather than named. A
vault that cannot be listed answers `503 unavailable`.

The route is not a new capability name. It is served to any caller declaring
0.34 or later, and an earlier minor is `409 incompatible_version`.

These files are copied byte-for-byte from the pinned Creek-Vault commit in
`vendor.json`. The base `creek_v1` bundle and the 0.22 pin stay unchanged:
adepthood declares 0.34 on the pipeline-status read only, and only to a vault
whose handshake lists 0.34 in `supported_contract_minors`. Every other call
keeps its own minor. Refresh this snapshot only from a reviewed immutable
commit.

The recorded SHA256 values are public artifact digests, not secrets.
