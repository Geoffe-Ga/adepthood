# Pipeline status totals 0.37

Creek contract 0.37 adds `totals` to `GET /v1/pipeline/status`
(Creek-Vault#2147, merged as #2149): `documents`, every upload document of the
caller whatever its tier and whatever `limit` asked for, and `stages`, one
`{stage, covered, partial, failed}` row per `PipelineStage` in pipeline order,
listed even at zero. The three counts are disjoint, and `ingested.covered` is
every document. The route's `documents` list is clamped to the newest 200, so
this is the only count that covers a larger corpus. It carries no filename, id
or path.

Creek sends `totals` to a caller declaring 0.37 or later. A caller declaring
0.34 to 0.36 is served the body its minor published, with no `totals` key
(`../creek_pipeline_status_v034`).

These files are copied byte-for-byte from the pinned Creek-Vault commit in
`vendor.json`. The base `creek_v1` bundle and the 0.22 pin stay unchanged:
adepthood declares 0.37 on the pipeline-status read only, and only to a vault
whose handshake lists 0.37 in `supported_contract_minors`; a vault listing 0.34
but not 0.37 is still asked at 0.34. Every other call keeps its own minor.
Refresh this snapshot only from a reviewed immutable commit.

The recorded SHA256 values are public artifact digests, not secrets.
