# Owner export 0.27

Creek contract 0.27 adds `GET /v1/export?cursor=&limit=` (capability
`export`, Creek-Vault#2033): one bounded page of the vault's own content --
every staged upload or attachment as its original bytes, then every fragment
file verbatim with its tier -- served only to the vault's sole configured
consumer. A vault that cannot be read answers `503 unavailable`, never a short
`200`.

These files are copied byte-for-byte from the pinned Creek-Vault commit in
`vendor.json`. The base `creek_v1` bundle and the 0.22 pin stay unchanged:
adepthood declares 0.27 on the export read only, and only to a vault whose
handshake both advertises `export` and lists 0.27 in
`supported_contract_minors`. Every other call keeps 0.22. Refresh this
snapshot only from a reviewed immutable commit.

The recorded SHA256 values are public artifact digests, not secrets.
